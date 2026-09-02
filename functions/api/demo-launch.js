/* GET /api/demo-launch?sid=<uuid>
 *
 * Validates the demo session, refreshes the cookie, and redirects to the
 * durable demo (first-party /demos/... or an external http(s) URL).
 * The durable URL is never returned as JSON.
 */
import { fail, requireEnv, failSetup } from '../_shared/http.js';
import { sbAdmin } from '../_shared/supabase.js';
import {
  sessionCookieHeader,
  firstPartyDemoPath
} from '../_shared/demo-gate.js';
import { resolveFeaturedPath } from '../_shared/featured-demos.js';
import { vetUrl } from '../_shared/net-safety.js';

function redirect(url, cookie) {
  const headers = { Location: url };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

export async function onRequestGet({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  } catch (e) {
    return failSetup(e);
  }

  const sid = new URL(request.url).searchParams.get('sid') || '';
  if (!/^[0-9a-f-]{36}$/i.test(sid)) {
    return fail('Invalid demo session.', 400);
  }

  let session;
  try {
    const rows = await sbAdmin(
      env,
      `/demo_sessions?select=id,demo_key,expires_at,unlimited&id=eq.${encodeURIComponent(sid)}&limit=1`
    );
    session = rows?.[0];
  } catch (e) {
    console.error('[demo-launch] lookup failed', e.message || e);
    return fail("Couldn't open the demo. Try starting the trial again.", 503);
  }

  if (!session) return fail('Demo session not found. Start the trial from the listing page.', 404);
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    return fail("Today's free trial for this tool has ended. Buy to keep using it, or come back tomorrow.", 403);
  }

  let target = null;
  const key = session.demo_key || '';

  if (key.startsWith('featured:')) {
    const id = key.slice('featured:'.length);
    target = resolveFeaturedPath(id);
    if (!target) return fail('Unknown featured demo.', 404);
  } else {
    const rows = await sbAdmin(
      env,
      `/listings?select=demo_url,has_demo&id=eq.${encodeURIComponent(key)}&limit=1`
    );
    const listing = rows?.[0];
    if (!listing?.demo_url) return fail('This listing has no demo.', 404);
    target = listing.demo_url.trim();
  }

  const firstParty = firstPartyDemoPath(target);
  if (firstParty) {
    return redirect(firstParty, sessionCookieHeader(session.id, session.expires_at));
  }

  // External seller demo — best-effort gate (they can bookmark after redirect).
  const vetted = vetUrl(target);
  if (vetted.error) return fail(vetted.error, 400);

  return redirect(vetted.url.toString(), sessionCookieHeader(session.id, session.expires_at));
}
