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
