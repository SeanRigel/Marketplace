/* Loads Cloudflare Web Analytics, but only if a token is configured.
 *
 * No token means no script, no beacon, and no third-party request — which is
 * why the privacy policy can say plainly that we run no advertising trackers.
 *
 * Cloudflare's beacon sets no cookies and builds no cross-site profile, so this
 * needs no consent banner. That is the reason it was picked over the more
 * obvious analytics products, along with it being a single tag in a project
 * that has no build step.
 */
(function () {
  var cfg = window.FORKABLE_CONFIG || {};
  var token = cfg.analyticsToken;
  if (!token) return;

  var s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: token }));
  document.head.appendChild(s);
})();
