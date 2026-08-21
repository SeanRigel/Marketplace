/* POST /api/check-demo  { url } -> { ok, status, latency_ms, error }
 *
 * Lets a signed-in seller test a demo URL before publishing, so "a listing without a
 * working demo won't pass review" is something they can satisfy themselves instead of
 * discovering from a rejection.
 *
 * This makes the server fetch a URL chosen by the caller, which is server-side request
 * forgery if left open. Signed-in callers only, and every address is vetted by
 * functions/_shared/net-safety.js — including each redirect hop, which is where the
 * first version of this leaked: it vetted the URL the caller sent, then followed
 * `redirect: 'follow'` wherever it led.
 */
import { json, fail, requireEnv, failSetup } from '../_shared/http.js';
import { requireUser } from '../_shared/supabase.js';
import { vetUrl, safeFetch, isPrivateHost } from '../_shared/net-safety.js';

const TIMEOUT_MS = 10000;

// Re-exported so existing callers and tests keep working; the implementation now
// lives in _shared/net-safety.js and is shared with the cron sweep.
export { isPrivateHost };

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  } catch (e) {
    return failSetup(e);
  }

  const { error } = await requireUser(request, env);
  if (error) return fail(error, 401);

  const body = await request.json().catch(() => ({}));
  if (!body.url) return fail('url is required.');

  const vetted = vetUrl(body.url);
  if (vetted.error) return json({ ok: false, error: vetted.error });
  const parsed = vetted.url;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await safeFetch(parsed.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Forkable-DemoCheck/1.0 (+listing health check)' }
    });
    const latency = Date.now() - started;

    // Read a small slice to sanity-check it's a page, not an error blob or a file.
    const text = await res.text().catch(() => '');
    const looksLikeHtml = /<html|<!doctype html|<body/i.test(text.slice(0, 2000));

    return json({
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      latency_ms: latency,
      looks_like_html: looksLikeHtml,
      error: res.status >= 400 ? `The server answered ${res.status}.` : null
    });
  } catch (e) {
    return json({
      ok: false,
      status: null,
      latency_ms: Date.now() - started,
      error: e.name === 'AbortError'
        ? `No response within ${TIMEOUT_MS / 1000}s.`
        : e.blocked ? e.message : `Could not reach it: ${e.message}`
    });
  } finally {
    clearTimeout(timer);
  }
}
