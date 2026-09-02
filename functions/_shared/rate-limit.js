/* Per-visitor rate limit.
 *
 * Prefers the SQL claim (atomic, shared across isolates). If that function
 * isn't installed yet, falls back to the Cache API so a fresh deploy still
 * has *some* teeth rather than none.
 *
 * Returns true when the caller is over the limit.
 */
import { sbAdmin } from './supabase.js';

function clientKey(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || '0.0.0.0';
}

export async function overLimit(request, env, bucket, limit, windowSeconds) {
  const key = clientKey(request);
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const claim = await sbAdmin(env, '/rpc/claim_rate_limit', {
        method: 'POST',
        body: {
          p_bucket: bucket,
          p_key: key,
          p_limit: limit,
          p_window_seconds: windowSeconds
        }
      });
      const verdict = Array.isArray(claim) ? claim[0] : claim;
      if (verdict && verdict.allowed === false) return true;
      if (verdict && verdict.allowed === true) return false;
    } catch {
      // Function not installed, or network blip — try the cache fallback.
    }
  }

  try {
    const cache = caches.default;
    const url = new URL('https://rate.forkable.invalid/' + encodeURIComponent(bucket) + '/' + encodeURIComponent(key));
    const hit = await cache.match(url);
    let n = 1;
    if (hit) {
      const prev = parseInt(await hit.text(), 10);
      n = (Number.isFinite(prev) ? prev : 0) + 1;
    }
    const resp = new Response(String(n), {
      headers: { 'Cache-Control': 'max-age=' + windowSeconds, 'Content-Type': 'text/plain' }
    });
    await cache.put(url, resp.clone());
    return n > limit;
  } catch {
    return false;
  }
}
