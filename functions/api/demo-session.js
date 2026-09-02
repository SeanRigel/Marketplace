/* POST /api/demo-session
 *   { listing_id } | { featured_id }
 * -> { ok, expires_at, unlimited, launch_url } + Set-Cookie fk_demo
 *
 * Mints or resumes today's timed trial for this visitor+demo. Sellers and
 * completed buyers get an unlimited session. Durable demo URLs never appear
 * in the JSON — the client only gets /api/demo-launch?sid=...
 */
import { json, fail, requireEnv, failSetup } from '../_shared/http.js';
import { sbAdmin } from '../_shared/supabase.js';
import {
  optionalUser,
  visitorKey,
  sessionCookieHeader,
  featuredDemoKey,
  FEATURED_DEMOS
} from '../_shared/demo-gate.js';
import { overLimit } from '../_shared/rate-limit.js';

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']);
  } catch (e) {
    return failSetup(e);
  }

  if (await overLimit(request, env, 'demo-session', 40, 3600)) {
    return fail('Too many demo trials from here. Try again later.', 429);
  }

  const body = await request.json().catch(() => ({}));
  const listingId = body.listing_id ? String(body.listing_id) : '';
  const featuredId = body.featured_id ? String(body.featured_id) : '';

  let demoKey = null;
  let unlimited = false;

  const { user } = await optionalUser(request, env);

  if (featuredId) {
    if (!FEATURED_DEMOS[featuredId]) {
      return fail('Unknown featured demo.', 404);
    }
    demoKey = featuredDemoKey(featuredId);
    // Featured landing demos are always trial-gated (no purchase yet).
    unlimited = false;
  } else if (listingId) {
    const rows = await sbAdmin(
      env,
      `/listings?select=id,seller_id,status,has_demo,demo_url&id=eq.${encodeURIComponent(listingId)}&limit=1`
    );
    const listing = rows?.[0];
    if (!listing) return fail('Listing not found.', 404);
    if (!listing.has_demo && !listing.demo_url) {
      return fail('This listing has no demo.', 404);
    }
    const isSeller = user?.id && listing.seller_id === user.id;
    if (listing.status !== 'live' && !isSeller) {
      return fail('Listing not found.', 404);
    }
    demoKey = listingId;

    if (user?.id) {
      if (listing.seller_id === user.id) {
        unlimited = true;
      } else {
        const purchases = await sbAdmin(
          env,
          `/purchases?select=id&listing_id=eq.${encodeURIComponent(listingId)}` +
            `&buyer_id=eq.${encodeURIComponent(user.id)}&status=eq.complete&limit=1`
        );
        if (purchases?.length) unlimited = true;
      }
    }
  } else {
    return fail('listing_id or featured_id is required.');
  }

  const vKey = await visitorKey(request, user?.id || null);

  let verdict;
  try {
    const claim = await sbAdmin(env, '/rpc/claim_demo_session', {
      method: 'POST',
      body: {
        p_demo_key: demoKey,
        p_visitor_key: vKey,
        p_unlimited: unlimited
      }
    });
    verdict = Array.isArray(claim) ? claim[0] : claim;
  } catch (e) {
    console.error('[demo-session] claim failed', e.message || e);
    return fail("Couldn't start a demo session. Try again in a moment.", 503);
  }

  if (!verdict || verdict.allowed === false) {
    return fail(
      "Today's free trial for this tool is used up. Buy to keep using it, or come back tomorrow.",
      429
    );
  }

  const sid = verdict.session_id;
  const expiresAt = verdict.expires_at;
  const launchUrl = '/api/demo-launch?sid=' + encodeURIComponent(sid);

  return json(
    {
      ok: true,
      expires_at: expiresAt,
      unlimited: !!verdict.unlimited,
      launch_url: launchUrl
    },
    200,
    { 'Set-Cookie': sessionCookieHeader(sid, expiresAt) }
  );
}
