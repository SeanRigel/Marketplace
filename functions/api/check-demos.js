/* POST /api/check-demos — verify every live listing's demo is actually up.
 *
 * The whole product claims "every listing has a working demo you can use before you
 * pay". Demos rot quietly: a domain lapses, a free tier sleeps, a deploy breaks. If
 * nothing checks, the claim becomes false one listing at a time and the first person
 * to notice is a buyer who then doesn't trust anything else on the site.
 *
 * Scheduled the same way as release-payouts (Pages has no cron), guarded by the same
 * CRON_SECRET. Run it hourly or daily.
 *
 * Deliberately does NOT auto-delist. A flaky check shouldn't yank a seller's listing;
 * it records failures, and the seller and admin see the count. Auto-delisting is a
 * decision to make once there's data on how noisy real checks are.
 */
import { json, fail, requireEnv } from '../_shared/http.js';
import { sbAdmin } from '../_shared/supabase.js';

const TIMEOUT_MS = 10000;
const FAILURES_BEFORE_ERROR = 2;   // one blip shouldn't mark a demo broken

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET']);
  } catch (e) {
    return fail(e.message, 500);
  }

  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!provided || !timingSafeEqual(provided, env.CRON_SECRET)) return fail('Unauthorized.', 401);

  let listings, existing;
  try {
    listings = await sbAdmin(env, '/listings?select=id,demo_url&status=eq.live&demo_url=not.is.null&limit=200');
    existing = await sbAdmin(env, '/sandbox_instances?select=listing_id,consecutive_failures');
  } catch (e) {
    return fail(e.message || 'Could not load listings.', 500);
  }

  if (!listings?.length) return json({ checked: 0, results: [] });

  const failuresByListing = Object.fromEntries(
    (existing || []).map((s) => [s.listing_id, s.consecutive_failures || 0])
  );

  const results = [];

  for (const listing of listings) {
    const check = await probe(listing.demo_url);
    const priorFailures = failuresByListing[listing.id] || 0;
    const failures = check.ok ? 0 : priorFailures + 1;

    try {
      await sbAdmin(env, '/sandbox_instances', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: {
          listing_id: listing.id,
          url: listing.demo_url,
          // One failed check is "still live, but noted"; sustained failure is an error.
          status: check.ok ? 'live' : (failures >= FAILURES_BEFORE_ERROR ? 'error' : 'live'),
          http_status: check.status,
          latency_ms: check.latency,
          consecutive_failures: failures,
          last_checked_at: new Date().toISOString(),
          last_error: check.error || null
        }
      });
    } catch (e) {
      // One unwritable row shouldn't abandon the rest of the sweep.
      results.push({ listing_id: listing.id, url: listing.demo_url, ok: check.ok, write_error: e.message });
      continue;
    }

    results.push({
      listing_id: listing.id,
      url: listing.demo_url,
      ok: check.ok,
      status: check.status,
      latency_ms: check.latency,
      consecutive_failures: failures,
      error: check.error
    });
  }

  const broken = results.filter((r) => !r.ok);
  return json({ checked: results.length, broken: broken.length, results });
}

async function probe(url) {
  // Only ever fetch http(s). A demo_url is seller-supplied text; without this a
  // seller could point the checker at internal addresses and read the response.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: null, latency: null, error: 'Not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, status: null, latency: null, error: `Unsupported protocol ${parsed.protocol}` };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // GET rather than HEAD: plenty of static hosts answer HEAD with 405 while the
    // page itself is perfectly fine.
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Forkable-DemoCheck/1.0 (+listing health check)' }
    });
    const latency = Date.now() - started;
    // Drain so the connection closes cleanly; we don't inspect the body.
    await res.arrayBuffer().catch(() => {});
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      latency,
      error: res.ok ? null : `HTTP ${res.status}`
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      latency: Date.now() - started,
      error: e.name === 'AbortError' ? `No response in ${TIMEOUT_MS / 1000}s` : e.message
    };
  } finally {
    clearTimeout(timer);
  }
}
