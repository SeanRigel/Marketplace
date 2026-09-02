/* Runs in front of Pages Functions (/api/*, /demos/*). Static HTML gets the
 * same locks from the `_headers` file at the repo root. */
import { applySecurityHeaders } from './_shared/security-headers.js';

export async function onRequest(context) {
  const res = await context.next();
  const headers = new Headers(res.headers);
  applySecurityHeaders(headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
}
