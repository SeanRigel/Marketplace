/* Helpers for the timed demo trial gate. */

import { FEATURED_DEMOS, featuredDemoKey, firstPartyDemoPath, isFirstPartyDemoPath }
  from './featured-demos.js';

const COOKIE = 'fk_demo';

export { FEATURED_DEMOS, featuredDemoKey, firstPartyDemoPath, isFirstPartyDemoPath };

export function demoCookieName() {
  return COOKIE;
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookieHeader(sessionId, expiresAt) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return `${COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export async function visitorKey(request, userId) {
  if (userId) return 'user:' + userId;
  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || '0.0.0.0';
  // IP only — hashing User-Agent let anyone mint a new daily trial by
  // changing one header.
  const data = new TextEncoder().encode('forkable-demo:' + ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'anon:' + hex;
}

/** Optional auth — returns { user } or {}. Never throws on missing token. */
export async function optionalUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return {};

  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return {};
  const user = await res.json();
  if (!user?.id) return {};
  return { user, token };
}

export function gateDeniedHtml(message) {
  const msg = message || 'This demo needs a free trial session from Forkable.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo locked — Forkable</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0b1220;color:#e8eef7;
    display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;}
  .card{max-width:420px;background:#121a2b;border:1px solid #243044;border-radius:14px;padding:28px;}
  h1{font-size:1.25rem;margin:0 0 10px} p{color:#9aa8bc;line-height:1.5;margin:0 0 18px}
  a{color:#6ee7b7;font-weight:600;text-decoration:none}
</style></head><body><div class="card">
  <h1>Demo locked</h1>
  <p>${msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
  <p><a href="/">← Back to Forkable</a></p>
</div></body></html>`;
}
