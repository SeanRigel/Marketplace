/* Supabase access from the server side.
 *
 * Two very different privilege levels live here, so they are two named functions
 * rather than one with a flag — it should be obvious at every call site which one
 * you reached for.
 *
 *   sbAdmin  — service_role. Bypasses RLS. Only for writes the user must not be
 *              able to make themselves (creating purchases, releasing payouts).
 *   sbAsUser — the caller's own JWT. RLS applies exactly as it would in the browser.
 */

function rest(env, path, opts, token) {
  return fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1${path}`, {
    method: opts.method || 'GET',
    headers: Object.assign(
      {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      opts.headers || {}
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).catch((e) => {
    // A bad hostname or a network blip otherwise escapes as an opaque runtime
    // error, which tells you nothing in the logs at 2am. Name it instead.
    throw new Error(`Could not reach Supabase (${env.SUPABASE_URL}): ${e.message}`);
  }).then(async (res) => {
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.message || body?.hint || `Supabase ${res.status}`);
    }
    return body;
  });
}

export function sbAdmin(env, path, opts = {}) {
  return rest(env, path, opts, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function sbAsUser(env, token, path, opts = {}) {
  return rest(env, path, opts, token);
}

/**
 * Resolves the caller's identity from their Authorization header by asking
 * GoTrue. Using the auth server directly means we never need the JWT signing
 * secret in this worker, and a revoked token stops working immediately.
 */
export async function requireUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: 'Not signed in.' };

  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return { error: 'Session expired — sign in again.' };

  const user = await res.json();
  if (!user?.id) return { error: 'Could not identify you.' };
  return { user, token };
}
