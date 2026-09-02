/* Browser locks that static HTML and API JSON should both send.
 *
 * These do not replace RLS / column privileges / URL vetting. They stop a
 * different class of bug: a stolen page being framed on someone else's site,
 * a injected <script src>, a referrer leaking a demo session query string.
 *
 * script-src keeps 'unsafe-inline' because index.html and app.html run inline
 * scripts (no build step, no nonces). That still blocks loading a script from
 * an attacker's domain. First-party demos fetch public APIs (Overpass, DNS),
 * so connect-src allows https.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com https://*.stripe.com",
  "object-src 'none'",
  'upgrade-insecure-requests'
].join('; ');

export function applySecurityHeaders(headers, opts) {
  opts = opts || {};
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // SAMEORIGIN, not DENY: the product iframes first-party /demos/* on this
  // origin. CSP frame-ancestors 'self' still blocks other sites from framing us.
  // Embeddable responses overwrite a DENY that static _headers may have set.
  if (opts.embeddable) {
    headers.delete('X-Frame-Options');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
  } else if (!headers.has('X-Frame-Options')) {
    headers.set('X-Frame-Options', 'SAMEORIGIN');
  }
  if (!headers.has('Permissions-Policy')) {
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
  }
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', CSP);
  return headers;
}
