/* Outbound-fetch safety for URLs a user chose.
 *
 * Two routes make the server fetch an address supplied by a seller:
 * /api/check-demo (a seller testing their own URL) and /api/check-demos (the
 * cron sweep, reading demo_url off live listings). Both run inside Cloudflare's
 * network, so an unguarded fetch is a probe for anything the worker can reach
 * that the public internet cannot.
 *
 * The first version of this lived in check-demo.js and matched hostnames with a
 * dotted-quad regex plus a small deny list. That let nine different spellings of
 * 127.0.0.1 and 169.254.169.254 straight through, because a hostname is not
 * required to be dotted-quad to resolve to an address:
 *
 *   http://2130706433/        -> 127.0.0.1   (32-bit decimal)
 *   http://0x7f000001/        -> 127.0.0.1   (hex)
 *   http://0177.0.0.1/        -> 127.0.0.1   (octal)
 *   http://127.1/             -> 127.0.0.1   (short form; inet_aton fills the gap)
 *   http://[::ffff:169.254.169.254]/ -> the metadata service over IPv4-mapped IPv6
 *
 * So the parsing here is deliberately inet_aton-shaped rather than regex-shaped:
 * turn whatever spelling arrived into a number, then test the number.
 *
 * WHAT THIS CANNOT DO: it sees hostnames, not the addresses they resolve to. A
 * name under someone else's control can point at 127.0.0.1 (localtest.me does,
 * publicly), and DNS can change between our check and the connection — the
 * classic rebinding window. Workers cannot resolve a name and pin the connection
 * to that address, so a literal-address check plus per-hop redirect validation is
 * the ceiling here. Anything that must be airtight belongs behind an allow-list
 * of hosts, not behind this.
 */

/* Parse every spelling of an IPv4 address that a resolver would accept.
 * Returns a 32-bit integer, or null if it isn't an IPv4 literal at all. */
export function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const nums = [];
  for (const part of parts) {
    if (part === '') return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) n = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else if (/^[0-9]+$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }

  // inet_aton: the final part absorbs whatever octets were left unwritten, which
  // is why 127.1 is 127.0.0.1 and 2130706433 is the whole address in one number.
  const last = nums[nums.length - 1];
  const leading = nums.slice(0, -1);
  if (leading.some((n) => n > 255)) return null;
  const remainingOctets = 4 - leading.length;
  if (last >= Math.pow(256, remainingOctets)) return null;

  let value = 0;
  for (const n of leading) value = (value * 256) + n;
  return (value * Math.pow(256, remainingOctets)) + last;
}

/* IPv4 ranges that must never be fetched on a caller's behalf, as [base, mask]. */
const V4_BLOCKED = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // RFC1918
  ['100.64.0.0', 10],      // CGNAT — a real path to carrier-side infrastructure
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12],      // RFC1918
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay anycast
  ['192.168.0.0', 16],     // RFC1918
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4]         // reserved, includes 255.255.255.255
];

function v4ToInt(dotted) {
  return dotted.split('.').reduce((acc, o) => (acc * 256) + Number(o), 0);
}

function v4InBlockedRange(value) {
  for (const [base, bits] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    // Both sides need >>> 0. `&` yields a SIGNED 32-bit int, so any range at or
    // above 128.0.0.0 (169.254/16, 172.16/12, 192.168/16, 224/4, 240/4 ...)
    // compares negative against an unsigned base and silently never matches —
    // which is exactly how an earlier version of this let the metadata address
    // through while appearing to block loopback correctly.
    const masked = (value & mask) >>> 0;
    const baseMasked = (v4ToInt(base) & mask) >>> 0;
    if (masked === baseMasked) return true;
  }
  return false;
}

const BLOCKED_NAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data'          // AWS's older metadata alias
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * True when this hostname must not be fetched. Accepts a hostname as `new URL()`
 * reports it (IPv6 still wrapped in brackets is fine).
 */
export function isPrivateHost(hostname) {
  if (!hostname) return true;
  let h = String(hostname).toLowerCase().trim();

  // Strip one trailing dot (fully-qualified form) and IPv6 brackets.
  if (h.endsWith('.')) h = h.slice(0, -1);
  h = h.replace(/^\[|\]$/g, '');
  if (!h) return true;

  if (BLOCKED_NAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;

  // IPv6, including the forms that carry an IPv4 address inside them.
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    if (/^fe[89ab]/.test(h)) return true;   // fe80::/10 link-local
    if (/^f[cd]/.test(h)) return true;      // fc00::/7 unique-local
    if (/^ff/.test(h)) return true;         // ff00::/8 multicast

    // ::ffff:127.0.0.1 and friends — test the embedded IPv4.
    const embedded = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (embedded) {
      const v = parseIPv4(embedded[1]);
      if (v !== null && v4InBlockedRange(v)) return true;
    }
    // ::ffff:7f00:1 — same address, written as hex groups.
    const groups = h.split(':').filter(Boolean);
    if (groups.length >= 2 && /^(ffff|0)$/.test(groups[groups.length - 2] || '')) {
      const tail = groups.slice(-2).join('');
      if (/^[0-9a-f]{1,8}$/.test(tail)) {
        const v = parseInt(groups.slice(-2).join('').padStart(8, '0'), 16);
        if (Number.isSafeInteger(v) && v4InBlockedRange(v)) return true;
      }
    }
    return false;
  }

  // IPv4 in any spelling.
  const v4 = parseIPv4(h);
  if (v4 !== null) return v4InBlockedRange(v4);

  return false;
}

/** Parses and vets a URL. Returns { url } or { error }. */
export function vetUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'Demo URLs must be http or https.' };
  }
  if (parsed.username || parsed.password) {
    // http://public.example.com@127.0.0.1/ — the part before @ is userinfo, and
    // the host is the bit after it. Refuse rather than rely on every reader
    // noticing that.
    return { error: 'URLs with embedded credentials are not allowed.' };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { error: 'That address is not reachable from the public internet.' };
  }
  return { url: parsed };
}

/**
 * fetch() that re-vets every redirect hop.
 *
 * `redirect: 'follow'` was the hole that made the original hostname check
 * decorative: a public URL that 302s to http://169.254.169.254/ passes the
 * pre-flight check and is then followed anyway. Redirects are resolved by hand
 * so each Location is vetted before it is connected to.
 */
export async function safeFetch(rawUrl, opts = {}, maxHops = 5) {
  const vetted = vetUrl(rawUrl);
  if (vetted.error) throw Object.assign(new Error(vetted.error), { blocked: true });

  let current = vetted.url;

  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(current.toString(), Object.assign({}, opts, { redirect: 'manual' }));

    if (res.status < 300 || res.status > 399) return res;

    const location = res.headers.get('Location');
    if (!location) return res;                     // 3xx with nowhere to go

    let next;
    try {
      next = new URL(location, current);           // may be relative
    } catch {
      throw Object.assign(new Error('Redirected to an invalid URL.'), { blocked: true });
    }

    const nextVetted = vetUrl(next.toString());
    if (nextVetted.error) {
      throw Object.assign(
        new Error('Redirected to an address that is not reachable from the public internet.'),
        { blocked: true }
      );
    }
    current = nextVetted.url;
  }

  throw Object.assign(new Error('Too many redirects.'), { blocked: true });
}
