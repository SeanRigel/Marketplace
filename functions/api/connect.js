/* Seller onboarding onto Stripe Connect Express.
 *
 * POST /api/connect  -> { url }      create (or resume) onboarding, return a link
 * GET  /api/connect  -> { status }   where this seller stands
 *
 * Express is doing the heavy lifting: identity verification, tax details, bank
 * account, and the payout schedule all live on Stripe's hosted pages. We never
 * see or store any of it — just the account id.
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

  const rows = await sbAdmin(env, `/profiles?select=id,stripe_connect_id&id=eq.${user.id}`);
  const profile = rows?.[0];
  if (!profile) return fail('Profile not found.', 404);

  let accountId = profile.stripe_connect_id;

  try {
    if (!accountId) {
      const account = await stripe(env, 'POST', '/accounts', {
        type: 'express',
        email: user.email,
        capabilities: { transfers: { requested: true } },
        business_profile: { product_description: 'Reusable software templates sold on Forkable' },
        metadata: { profile_id: user.id }
      }, { idempotencyKey: `connect-account:${user.id}` });

      accountId = account.id;

      // Written with service_role: stripe_connect_id is revoked from client writes
      // precisely so a seller cannot point their payouts at someone else's account.
      await sbAdmin(env, `/profiles?id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { stripe_connect_id: accountId }
      });
    }

    const siteUrl = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
    const link = await stripe(env, 'POST', '/account_links', {
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${siteUrl}/app.html#/dashboard/seller?connect=refresh`,
      return_url: `${siteUrl}/app.html#/dashboard/seller?connect=done`
    });

    return json({ url: link.url });
  } catch (e) {
    return fail(e.message || 'Could not start Stripe onboarding.', 502);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    requireEnv(env, ['STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']);
  } catch (e) {
    return fail(e.message, 500);
  }

  const { user, error } = await requireUser(request, env);
  if (error) return fail(error, 401);

  const rows = await sbAdmin(env, `/profiles?select=stripe_connect_id,stripe_charges_enabled,stripe_payouts_enabled,stripe_details_submitted&id=eq.${user.id}`);
  const p = rows?.[0];

  if (!p?.stripe_connect_id) {
    return json({ connected: false, charges_enabled: false, payouts_enabled: false });
  }

  // Ask Stripe directly rather than trusting our cached copy: account.updated can
  // be missed, and a seller staring at a stale "pending" is a support ticket.
  try {
    const account = await stripe(env, 'GET', `/accounts/${p.stripe_connect_id}`);

    if (
      account.charges_enabled !== p.stripe_charges_enabled ||
      account.payouts_enabled !== p.stripe_payouts_enabled
    ) {
      await sbAdmin(env, `/profiles?id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: {
          stripe_charges_enabled: !!account.charges_enabled,
          stripe_payouts_enabled: !!account.payouts_enabled,
          stripe_details_submitted: !!account.details_submitted
        }
      });
    }

    return json({
      connected: true,
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      details_submitted: !!account.details_submitted,
      requirements_due: account.requirements?.currently_due || []
    });
  } catch (e) {
    return json({
      connected: true,
      charges_enabled: p.stripe_charges_enabled,
      payouts_enabled: p.stripe_payouts_enabled,
      stale: true,
      error: e.message
    });
  }
}
