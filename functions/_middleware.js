/* Runs in front of Pages Functions (/api/*, /demos/*). Static HTML gets the
 * same locks from the `_headers` file at the repo root. */
import { applySecurityHeaders } from './_shared/security-headers.js';

function isEmbeddable(pathname) {
  return pathname.startsWith('/demos/') || pathname === '/api/demo-launch';
}

export async function onRequest(context) {
  const res = await context.next();
  const headers = new Headers(res.headers);
  const path = new URL(context.request.url).pathname;
  applySecurityHeaders(headers, { embeddable: isEmbeddable(path) });
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
}
