/* URL safety helpers in db.js — the guards that stand between a seller-supplied
 * string and an href/src. Run: node app/url-safety.test.mjs
 *
 * db.js is a browser IIFE, so we shim just enough of a browser to load it and
 * then poke at window.FKUrl.
 */
import fs from 'node:fs';
import assert from 'node:assert';

const APP_ORIGIN = 'https://forkable.pages.dev';
const SRC = fs.readFileSync(new URL('./db.js', import.meta.url), 'utf8');

/* Load db.js fresh with a given config, return its FKUrl. */
function load(config) {
  const store = {};
  const g = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    location: { origin: APP_ORIGIN, href: APP_ORIGIN + '/app.html' },
    FORKABLE_CONFIG: config,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    URL, fetch: () => Promise.reject(new Error('no network in tests')),
    console
  };
  g.window = g;
  // eslint-disable-next-line no-new-func
  new Function('window', 'localStorage', 'location', 'crypto', 'URL', 'fetch', 'console', SRC)
    .call(g, g, g.localStorage, g.location, g.crypto, URL, g.fetch, console);
  return g.FKUrl;
}

const U = load({ demoOrigin: '' });
let n = 0;
const ok = (label, cond) => { assert.ok(cond, label); n++; };

/* ---- scheme: the javascript: hole ------------------------------------- */
for (const bad of [
  'javascript:alert(1)',
  '  javascript:alert(document.cookie)  ',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://forkable.pages.dev/abc'
]) {
  ok('safeUrl rejects ' + bad, U.safeUrl(bad) === null);
  ok('safeHref gives no href for ' + bad, U.safeHref(bad) === '');
  ok('demoFrame refuses ' + bad, U.demoFrame(bad).ok === false && U.demoFrame(bad).reason === 'scheme');
}

ok('empty is not a URL', U.safeUrl('') === null && U.safeUrl(null) === null);

/* ---- scheme: the good cases still work -------------------------------- */
ok('https passes', U.safeHref('https://github.com/rigel/tool') === 'https://github.com/rigel/tool');
ok('http passes', U.safeUrl('http://example.com/x') !== null);

/* ---- origin: cross-origin demos are the safe, normal case ------------- */
const cross = U.demoFrame('https://seller.example.com/demo/');
ok('cross-origin demo embeds', cross.ok === true && cross.reason === 'cross-origin');
ok('cross-origin demo keeps allow-same-origin', cross.sandbox.includes('allow-same-origin'));

/* ---- origin: our own demos are trusted -------------------------------- */
const mine = U.demoFrame('demos/guard-scheduler/index.html');
ok('first-party demo embeds', mine.ok === true && mine.reason === 'first-party');
ok('first-party demo keeps allow-same-origin', mine.sandbox.includes('allow-same-origin'));
ok('first-party demo resolves to our origin', mine.src.startsWith(APP_ORIGIN + '/demos/'));

/* ---- origin: same-origin and NOT ours is the hole this closes --------- */
for (const sneaky of [
  '/app.html',
  APP_ORIGIN + '/app.html',
  'demos/../app.html',                 // normalises to /app.html
  'demos/../../app.html',
  '/demos-not-really/evil.html'        // prefix must be the whole path segment
]) {
  const f = U.demoFrame(sneaky);
  ok('refuses same-origin non-demo ' + sneaky, f.ok === false && f.reason === 'same-origin');
  ok('no allow-same-origin for ' + sneaky, !f.sandbox.includes('allow-same-origin'));
}

/* ---- demoOrigin moves first-party demos off this origin --------------- */
const DEMOS = 'https://demos.forkable.dev';
const V = load({ demoOrigin: DEMOS });
const moved = V.demoFrame('demos/guard-scheduler/index.html');
ok('demoOrigin rehosts first-party demos', moved.src === DEMOS + '/demos/guard-scheduler/index.html');
ok('rehosted demo is now cross-origin', moved.ok === true && moved.reason === 'cross-origin');

const movedTrailing = load({ demoOrigin: DEMOS + '/' }).demoFrame('demos/lead-scout/index.html');
ok('trailing slash on demoOrigin is tolerated',
  movedTrailing.src === DEMOS + '/demos/lead-scout/index.html');

ok('demoOrigin does not rescue a same-origin non-demo',
  V.demoFrame('/app.html').ok === false);
ok('demoOrigin does not rescue a bad scheme',
  V.demoFrame('javascript:alert(1)').ok === false);

console.log('  ' + n + ' assertions passed');
