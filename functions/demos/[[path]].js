/* Gate every /demos/* static asset behind a valid fk_demo session cookie.
 *
 * Without this, hiding demo_url in the API is decorative — anyone who knows
 * /demos/guard-scheduler/ can use the tool forever. ASSETS.fetch serves the
 * real file only after the session checks out.
 */
import { sbAdmin } from '../_shared/supabase.js';
import {
  parseCookies,
  demoCookieName,
  gateDeniedHtml,
  firstPartyDemoPath
} from '../_shared/demo-gate.js';
import { resolveFeaturedPath } from '../_shared/featured-demos.js';

function dirnameOf(path) {
  const p = path.endsWith('/') ? path.slice(0, -1) : path;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i + 1);
}

async function allowedPrefix(env, session) {
  const key = session.demo_key || '';
  let target = null;
  if (key.startsWith('featured:')) {
    target = resolveFeaturedPath(key.slice('featured:'.length));
  } else if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const rows = await sbAdmin(
        env,
        `/listings?select=demo_url&id=eq.${encodeURIComponent(key)}&limit=1`
      );
      target = rows?.[0]?.demo_url || null;
    } catch (e) {
      console.error('[demos-gate] listing lookup', e.message || e);
      return null;
    }
  }
  const path = firstPartyDemoPath(target);
  if (!path) return null;
  return dirnameOf(path);
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Only gate our demo tree.
  if (!url.pathname.startsWith('/demos/')) {
    return next();
  }

  // If Supabase isn't configured yet, fail closed — otherwise the gate is a lie.
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      gateDeniedHtml('Demo trials are not switched on yet. Check back shortly.'),
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const cookies = parseCookies(request);
  const sid = cookies[demoCookieName()] || '';
  if (!/^[0-9a-f-]{36}$/i.test(sid)) {
    return new Response(
      gateDeniedHtml(
        "Start a free trial from the listing page first. Direct links to demos aren't open forever — that's the whole point of Forkable."
      ),
      { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  let session;
  try {
    const rows = await sbAdmin(
      env,
      `/demo_sessions?select=id,demo_key,expires_at&id=eq.${encodeURIComponent(sid)}&limit=1`
    );
    session = rows?.[0];
  } catch (e) {
    console.error('[demos-gate] session lookup', e.message || e);
    return new Response(
      gateDeniedHtml("Couldn't verify your demo session. Open the listing and try again."),
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    return new Response(
      gateDeniedHtml(
        "Today's free trial has ended. Buy the tool to keep using it, or come back tomorrow."
      ),
      { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const prefix = await allowedPrefix(env, session);
  if (!prefix || !url.pathname.startsWith(prefix)) {
    return new Response(
      gateDeniedHtml('This demo session is for a different tool. Start a trial from its listing page.'),
      { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  // Serve the static asset from the Pages deployment.
  if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    return env.ASSETS.fetch(request);
  }

  // Local wrangler / unexpected runtime: fall through to the static pipeline.
  return next();
}
