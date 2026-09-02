/* POST /api/waitlist  { email, role, note }
 *
 * The landing page used to insert with the public anon key. That meant anyone
 * who copied the key (it's in config.js on purpose) could flood the table.
 * This route is the only writer: service_role insert + per-IP rate limit.
 */
import { json, fail, requireEnv, failSetup } from '../_shared/http.js';
import { sbAdmin } from '../_shared/supabase.js';
import { overLimit } from '../_shared/rate-limit.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = new Set(['buyer', 'seller', 'both']);

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  } catch (e) {
    return failSetup(e);
  }

  if (await overLimit(request, env, 'waitlist', 8, 3600)) {
    return fail('Too many signups from here. Try again later.', 429);
  }

  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const role = ROLES.has(body.role) ? body.role : 'both';
  const note = body.note ? String(body.note).slice(0, 2000) : null;

  if (!EMAIL.test(email) || email.length > 320) {
    return fail("That email doesn't look right.");
  }

  try {
    await sbAdmin(env, '/waitlist', {
      method: 'POST',
      body: { email, role, note },
      headers: { Prefer: 'return=minimal' }
    });
  } catch (e) {
    const msg = String(e.message || '');
    if (/duplicate|unique|23505/i.test(msg) || msg.includes('409')) {
      return json({ ok: true, already: true });
    }
    console.error('[waitlist]', msg);
    return fail("Couldn't save that just now. Try again.", 503);
  }

  return json({ ok: true });
}
