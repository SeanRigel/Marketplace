/* POST /api/check-demo  { url } -> { ok, status, latency_ms, error }
 *
 * Lets a signed-in seller test a demo URL before publishing, so "a listing without a
 * working demo won't pass review" is something they can satisfy themselves instead of
 * discovering from a rejection.
 *
 * This makes the server fetch a URL chosen by the caller, which is server-side request
 * forgery if left open. Signed-in callers only, http(s) only, and private/loopback
 * hosts are refused — the worker sits inside Cloudflare's network and must not be
 * usable as a probe for anything that isn't the public internet.
 */
import { json, fail, requireEnv } from '../_shared/http.js';
import { requireUser } from '../_shared/supabase.js';

const TIMEOUT_MS = 10000;

// Literal addresses that must never be fetched on a caller's behalf.
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  'metadata.google.internal', '169.254.169.254'
]);

export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;

  // IPv4 private and link-local ranges.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  // IPv6 loopback / unique-local / link-local.
  if (h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;

  return false;
}

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  } catch (e) {
    return fail(e.message, 500);
  }

  const { error } = await requireUser(request, env);
  if (error) return fail(error, 401);

  const body = await request.json().catch(() => ({}));
  if (!body.url) return fail('url is required.');

  let parsed;
  try {
    parsed = new URL(body.url);
  } catch {
    return json({ ok: false, error: 'That is not a valid URL.' });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return json({ ok: false, error: 'Demo URLs must be http or https.' });
  }
  if (isPrivateHost(parsed.hostname)) {
    return json({ ok: false, error: 'That address is not reachable from the public internet.' });
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
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
        : `Could not reach it: ${e.message}`
    });
  } finally {
    clearTimeout(timer);
  }
}
