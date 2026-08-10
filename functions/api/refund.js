/* POST /api/refund  { purchase_id, reason? } -> { refunded: true }
 *
 * The outcome guarantee, as code. Self-service and buyer-favourable by design:
 * inside the window the buyer clicks once and the money goes back. There is no
 * seller approval step and no dispute queue — per the brief, trust matters more
 * than fraud-proofing at this stage. Revisit if abuse shows up in the data.
 *
 * This can only ever succeed while the seller's money is still held, because
 * release-payouts.js refuses to transfer anything whose window hasn't closed.
 */
import { json, fail, requireEnv } from '../_shared/http.js';
import { stripe } from '../_shared/stripe.js';
import { sbAdmin, requireUser } from '../_shared/supabase.js';

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']);
  } catch (e) {
    return fail(e.message, 500);
  }

  const { user, error } = await requireUser(request, env);
  if (error) return fail(error, 401);

  const body = await request.json().catch(() => ({}));
  if (!body.purchase_id) return fail('purchase_id is required.');

  const rows = await sbAdmin(
    env,
    `/purchases?select=*&id=eq.${encodeURIComponent(body.purchase_id)}`
  );
  const purchase = rows?.[0];

  if (!purchase) return fail('Purchase not found.', 404);

  // Ownership is checked here, server-side, not inferred from what the client sent.
  if (purchase.buyer_id !== user.id) return fail('That is not your purchase.', 403);

  if (purchase.status === 'refunded') return json({ refunded: true, already: true });
  if (purchase.status !== 'complete') return fail('That purchase is not refundable.', 409);

  if (new Date(purchase.refund_window_expires_at).getTime() < Date.now()) {
    return fail('The refund window for this purchase has closed.', 409);
  }

  // Belt and braces: if a payout somehow went out early, a plain refund would
  // leave the platform short. Surface it instead of silently eating the loss.
  if (purchase.payout_transfer_id) {
    return fail('This purchase has already been paid out — contact support.', 409);
  }

  try {
    await stripe(env, 'POST', '/refunds', {
      payment_intent: purchase.stripe_payment_intent_id,
      reason: 'requested_by_customer',
      metadata: {
        purchase_id: purchase.id,
        buyer_reason: (body.reason || '').slice(0, 400)
      }
    }, { idempotencyKey: `refund:${purchase.id}` });
  } catch (e) {
    return fail(e.message || 'Stripe refused the refund.', 502);
  }

  // charge.refunded will also set this; writing it now means the UI updates
  // immediately instead of waiting on webhook delivery.
  await sbAdmin(env, `/purchases?id=eq.${purchase.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: {
      status: 'refunded',
      refunded_at: new Date().toISOString(),
      refund_reason: (body.reason || '').slice(0, 400) || null
    }
  });

  return json({ refunded: true });
}
