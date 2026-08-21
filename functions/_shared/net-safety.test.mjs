/* Guards functions/_shared/net-safety.js.
 *
 * Every "bypass" case below was ALLOWED by the original check in check-demo.js,
 * verified by running it. They are here so the same spellings cannot come back.
 *
 * Run via ./scripts/test.sh.
 */
import { isPrivateHost, parseIPv4, vetUrl, safeFetch } from './net-safety.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { pass++; }
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${expected}, got ${actual}`); }
}

/* ---------------------------------------------------- inet_aton parsing */
check('parseIPv4 dotted quad',      parseIPv4('127.0.0.1'),   2130706433);
check('parseIPv4 32-bit decimal',   parseIPv4('2130706433'),  2130706433);
check('parseIPv4 hex',              parseIPv4('0x7f000001'),  2130706433);
check('parseIPv4 octal',            parseIPv4('0177.0.0.1'),  2130706433);
check('parseIPv4 short form 127.1', parseIPv4('127.1'),       2130706433);
check('parseIPv4 three-part',       parseIPv4('127.0.1'),     2130706433 - 0 + 0); // 127.0.0.1
check('parseIPv4 rejects hostname', parseIPv4('example.com'), null);
check('parseIPv4 rejects overflow', parseIPv4('256.0.0.1'),   null);
check('parseIPv4 rejects empty',    parseIPv4(''),            null);

/* ---------------------------------------------------- must be blocked */
const blocked = [
  ['127.0.0.1',                  'plain loopback'],
  ['169.254.169.254',            'cloud metadata'],
  ['10.0.0.5',                   'RFC1918 /8'],
  ['172.16.0.1',                 'RFC1918 /12'],
  ['192.168.1.1',                'RFC1918 /16'],
  ['0.0.0.0',                    'this-network'],
  ['localhost',                  'localhost by name'],
  ['LOCALHOST',                  'localhost, uppercase'],
  ['localhost.',                 'localhost, fully qualified'],
  ['anything.localhost',         'localhost suffix'],
  ['db.internal',               '.internal suffix'],
  ['printer.local',              '.local suffix'],
  ['metadata.google.internal',   'GCP metadata by name'],
  // --- the nine that used to get through ---
  ['2130706433',                 'decimal-encoded loopback'],
  ['0x7f000001',                 'hex-encoded loopback'],
  ['127.1',                      'short-form loopback'],
  ['0177.0.0.1',                 'octal-encoded loopback'],
  ['::ffff:127.0.0.1',           'IPv4-mapped IPv6 loopback'],
  ['::ffff:169.254.169.254',     'IPv4-mapped IPv6 metadata'],
  ['100.64.0.1',                 'CGNAT'],
  ['192.0.0.1',                  'IETF protocol assignments'],
  ['198.18.0.1',                 'benchmarking range'],
  // --- IPv6 ---
  ['::1',                        'IPv6 loopback'],
  ['[::1]',                      'IPv6 loopback, bracketed'],
  ['::',                         'IPv6 unspecified'],
  ['fe80::1',                    'IPv6 link-local'],
  ['fd00::1',                    'IPv6 unique-local'],
  ['ff02::1',                    'IPv6 multicast'],
  // --- other reserved ---
  ['224.0.0.1',                  'multicast'],
  ['255.255.255.255',            'broadcast'],
  ['192.0.2.5',                  'TEST-NET-1'],
];
for (const [host, label] of blocked) check(`blocks ${label} (${host})`, isPrivateHost(host), true);

/* ---------------------------------------------------- must be allowed */
const allowed = [
  ['example.com',      'ordinary hostname'],
  ['demos.forkable.dev','subdomain'],
  ['8.8.8.8',          'public IPv4'],
  ['1.1.1.1',          'public IPv4'],
  ['93.184.216.34',    'public IPv4'],
  ['2606:4700::1111',  'public IPv6'],
  ['172.32.0.1',       'just outside RFC1918 /12'],
  ['172.15.0.1',       'just below RFC1918 /12'],
  ['100.63.255.255',   'just below CGNAT'],
  ['100.128.0.1',      'just above CGNAT'],
  ['11.0.0.1',         'just above 10/8'],
  ['126.255.255.255',  'just below loopback /8'],
  ['128.0.0.1',        'just above loopback /8'],
];
for (const [host, label] of allowed) check(`allows ${label} (${host})`, isPrivateHost(host), false);

/* ---------------------------------------------------- vetUrl */
check('vetUrl rejects javascript:', !!vetUrl('javascript:alert(1)').error, true);
check('vetUrl rejects file:',       !!vetUrl('file:///etc/passwd').error,  true);
check('vetUrl rejects gopher:',     !!vetUrl('gopher://x/').error,         true);
check('vetUrl rejects garbage',     !!vetUrl('not a url').error,           true);
check('vetUrl rejects loopback',    !!vetUrl('http://127.0.0.1/').error,   true);
check('vetUrl rejects decimal loopback', !!vetUrl('http://2130706433/').error, true);
check('vetUrl rejects userinfo host-confusion',
      !!vetUrl('http://example.com@127.0.0.1/').error, true);
check('vetUrl allows a normal https url', !!vetUrl('https://example.com/demo').error, false);
check('vetUrl allows http',               !!vetUrl('http://example.com/').error,      false);

/* ---------------------------------------------------- redirect re-vetting */
/* The original code used redirect:'follow', so a public URL that redirects to a
 * private one was fetched anyway. safeFetch resolves hops by hand; stub fetch
 * and confirm it refuses the second hop and never connects to it. */
const realFetch = globalThis.fetch;
const connected = [];

globalThis.fetch = async (url) => {
  connected.push(String(url));
  if (String(url).startsWith('https://public.example.com')) {
    return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
  }
  return new Response('ok', { status: 200 });
};

let redirectBlocked = false;
try {
  await safeFetch('https://public.example.com/demo');
} catch (e) {
  redirectBlocked = !!e.blocked;
}
check('safeFetch refuses a redirect into link-local', redirectBlocked, true);
check('safeFetch never connected to the metadata address',
      connected.some((u) => u.includes('169.254.169.254')), false);

/* A redirect chain that stays public should still work. */
connected.length = 0;
globalThis.fetch = async (url) => {
  connected.push(String(url));
  if (String(url) === 'https://a.example.com/') {
    return new Response(null, { status: 301, headers: { Location: 'https://b.example.com/' } });
  }
  return new Response('ok', { status: 200 });
};
const okRes = await safeFetch('https://a.example.com/');
check('safeFetch follows a public redirect', okRes.status, 200);
check('safeFetch followed exactly two hops', connected.length, 2);

/* A redirect loop must terminate rather than hang. */
globalThis.fetch = async () =>
  new Response(null, { status: 302, headers: { Location: 'https://loop.example.com/' } });
let loopStopped = false;
try { await safeFetch('https://loop.example.com/'); }
catch (e) { loopStopped = /too many redirects/i.test(e.message); }
check('safeFetch stops a redirect loop', loopStopped, true);

globalThis.fetch = realFetch;

/* ---------------------------------------------------- report */
if (fail) {
  console.log(`\n  ${pass} passed, ${fail} FAILED`);
  process.exit(1);
}
console.log(`  ${pass} assertions passed`);
