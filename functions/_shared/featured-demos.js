/* Server-side allowlist for landing-page featured demos.
 *
 * config.js still names these for marketing copy, but the durable path must
 * not be trusted from the client when minting a session — otherwise anyone
 * could ask for featured:whatever and get a cookie for an arbitrary path.
 */

export const FEATURED_DEMOS = {
  'guard-scheduler': {
    path: '/demos/guard-scheduler/index.html',
    title: 'Shift Scheduler w/ AI Constraint Parser'
  },
  'lead-scout': {
    path: '/demos/lead-scout/index.html',
    title: 'Local Lead Scout — Businesses With No Website'
  },
  'reconsole': {
    path: '/demos/reconsole/index.html',
    title: 'RECONSOLE — Client-Side OSINT Console'
  }
};

export function featuredDemoKey(id) {
  return 'featured:' + id;
}

export function resolveFeaturedPath(id) {
  const row = FEATURED_DEMOS[id];
  return row ? row.path : null;
}

/** True when a URL/path is one of our first-party demos under /demos/.
 * Absolute http(s) URLs are never first-party here — even if the path is
 * `/demos/...` on someone else's host. Those go through the redirect gate. */
export function isFirstPartyDemoPath(urlOrPath) {
  if (!urlOrPath || typeof urlOrPath !== 'string') return false;
  const s = urlOrPath.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false; // has a scheme
  if (!(s.startsWith('/demos/') || s.startsWith('demos/'))) return false;
  // Traversal: demos/../app.html must not count as first-party.
  const norm = s.replace(/^\/+/, '').replace(/\/+$/, '').split('?')[0].split('#')[0];
  const parts = norm.split('/').filter(Boolean);
  if (parts[0] !== 'demos') return false;
  if (parts.some((p) => p === '..')) return false;
  return parts.length >= 2; // need /demos/<something>
}

/** Normalise to a root-relative /demos/... path, or null. */
export function firstPartyDemoPath(urlOrPath) {
  if (!isFirstPartyDemoPath(urlOrPath)) return null;
  const s = urlOrPath.trim().split('?')[0].split('#')[0];
  if (s.startsWith('/demos/')) return s;
  return '/' + s;
}
