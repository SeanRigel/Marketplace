/* POST /api/release-payouts — pay sellers whose refund windows have closed.
 *
 * This is the other half of the guarantee. Checkout puts money on the platform
 * account with no destination transfer; this job creates the transfer to the
 * seller's Connect account once the buyer can no longer refund. Until this runs,
 * the seller has not been paid — which is exactly what makes the promise credible.
 *
 * Pages Functions have no cron trigger, so this is an HTTP endpoint guarded by a
 * shared secret. Point any scheduler at it (Supabase pg_cron, a GitHub Action, or
 * cron-job.org); daily is plenty. See README for the exact setup.
 */
import { json, fail, requireEnv } from '../_shared/http.js';
import { stripe } from '../_shared/stripe.js';
import { sbAdmin } from '../_shared/supabase.js';

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET']);
  } catch (e) {
    return fail(e.message, 500);
  }

  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!provided || !timingSafeEqual(provided, env.CRON_SECRET)) {
    return fail('Unauthorized.', 401);
  }

  // payouts_due already filters to: complete, unrefunded, window closed, seller
  // onboarded with payouts enabled.
  const due = await sbAdmin(env, '/payouts_due?select=*&limit=100');
  if (!due?.length) return json({ released: 0, results: [] });

  const results = [];

  for (const row of due) {
    if (row.seller_cents <= 0) {
      results.push({ purchase_id: row.purchase_id, skipped: 'nothing to transfer' });
      continue;
    }

    try {
      const transfer = await stripe(env, 'POST', '/transfers', {
        amount: row.seller_cents,
        currency: 'usd',
        destination: row.stripe_connect_id,
        source_transaction: row.stripe_charge_id || undefined,
        metadata: { purchase_id: row.purchase_id }
      }, {
        // The critical one. If this job runs twice, or a response is lost after
        // Stripe committed, the seller is still paid exactly once.
        idempotencyKey: `payout:${row.purchase_id}`
      });

      await sbAdmin(env, `/purchases?id=eq.${row.purchase_id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { payout_transfer_id: transfer.id, payout_released_at: new Date().toISOString() }
      });

      results.push({ purchase_id: row.purchase_id, transfer_id: transfer.id, amount: row.seller_cents });
    } catch (e) {
      // One bad seller account must not stop everyone else getting paid.
      results.push({ purchase_id: row.purchase_id, error: e.message });
    }
  }

  return json({ released: results.filter((r) => r.transfer_id).length, results });
}
