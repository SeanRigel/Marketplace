/* Tiny response helpers shared by every function. */

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders)
  });
}

export function fail(message, status = 400) {
  return json({ error: message }, status);
}

/* Every handler runs this first. A missing env var should read as a clear setup
 * error in the logs, not as a mysterious 500 three calls deeper. */
export function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    throw new Error('Missing environment variable(s): ' + missing.join(', '));
  }
}

/* The paired response for a requireEnv throw.
 *
 * The variable names go to the logs, never to the page. During the validation
 * window the site is public while Stripe is still in review, so a stranger can
 * reach a payment route before its keys exist — and "Missing environment
 * variable(s): STRIPE_SECRET_KEY" is both alarming and a free hint about the
 * stack. They get a sentence that is true; the operator gets the detail in
 * `wrangler tail` or the Pages log.
 *
 * 503, not 500: nothing is broken, it just isn't switched on yet. */
export function failSetup(e) {
  console.error('[setup] ' + (e && e.message ? e.message : e));
  return fail("This part of the site isn't switched on yet.", 503);
}
