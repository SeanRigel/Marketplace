/* Guards functions/_shared/notify.js.
 *
 * The rule these exist to protect: EMAIL MUST NEVER BREAK THE MONEY PATH.
 *
 * The Stripe webhook returns 500 to request a retry. If a failed send propagated
 * out of onCheckoutComplete, Stripe would redeliver an event we already handled,
 * and a mail outage would become repeated purchase writes. So every failure mode
 * below — no key, no recipient, HTTP error, network throw — has to resolve, not
 * reject. A test suite that only checked the happy path would be worthless here.
 *
 * Run via ./scripts/test.sh.
 */
import {
  sendEmail, userEmail, escapeHtml,
  buyerReceipt, sellerSale, buyerRefunded, sellerRefunded, demoBroken
} from './notify.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) pass++;
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${expected}, got ${actual}`); }
}
function ok(label, cond) { check(label, !!cond, true); }

const realFetch = globalThis.fetch;
const BASE = { SITE_URL: 'https://forkable.dev', SUPABASE_URL: 'https://x.supabase.co',
               SUPABASE_SERVICE_ROLE_KEY: 'service-role' };

/* ------------------------------------------------ unset key = silence */
{
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };

  const r = await sendEmail({}, { to: 'a@b.com', subject: 'x', text: 'y' });
  check('no API key -> not sent', r.sent, false);
  check('no API key -> reports why', r.skipped, 'no_api_key');
  check('no API key -> makes no network call', called, false);
}

/* ------------------------------------------------ missing recipient */
{
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const r = await sendEmail({ RESEND_API_KEY: 'k' }, { to: null, subject: 'x', text: 'y' });
  check('no recipient -> not sent', r.sent, false);
  check('no recipient -> resolves rather than throwing', r.skipped, 'no_recipient');
}

/* ------------------------------------------------ happy path */
{
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body), headers: opts.headers };
    return new Response('{"id":"abc"}', { status: 200 });
  };

  const r = await sendEmail(
    { RESEND_API_KEY: 'k', MAIL_FROM: 'Forkable <hi@forkable.dev>', SUPPORT_EMAIL: 'help@forkable.dev' },
    { to: 'buyer@example.com', subject: 'Your purchase', text: 'thanks', html: '<p>thanks</p>' }
  );
  check('sends when configured', r.sent, true);
  ok('posts to Resend', captured.url.includes('api.resend.com'));
  check('recipient is an array', Array.isArray(captured.body.to), true);
  check('recipient correct', captured.body.to[0], 'buyer@example.com');
  check('from honours MAIL_FROM', captured.body.from, 'Forkable <hi@forkable.dev>');
  check('reply_to honours SUPPORT_EMAIL', captured.body.reply_to, 'help@forkable.dev');
  ok('authorization header set', /Bearer k/.test(captured.headers.Authorization));
}

/* SUPPORT_EMAIL unset must simply omit reply_to, not send "undefined". */
{
  let body = null;
  globalThis.fetch = async (u, o) => { body = JSON.parse(o.body); return new Response('{}', { status: 200 }); };
  await sendEmail({ RESEND_API_KEY: 'k' }, { to: 'a@b.com', subject: 's', text: 't' });
  check('no SUPPORT_EMAIL -> reply_to omitted', 'reply_to' in body, false);
}

/* ------------------------------------------------ failures must not throw */
{
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });
  let threw = false;
  let r;
  try { r = await sendEmail({ RESEND_API_KEY: 'k' }, { to: 'a@b.com', subject: 's', text: 't' }); }
  catch { threw = true; }
  check('HTTP error does not throw', threw, false);
  check('HTTP error reports not-sent', r.sent, false);
  check('HTTP error names the status', r.error, 'resend_429');
}
{
  globalThis.fetch = async () => { throw new Error('network down'); };
  let threw = false;
  let r;
  try { r = await sendEmail({ RESEND_API_KEY: 'k' }, { to: 'a@b.com', subject: 's', text: 't' }); }
  catch { threw = true; }
  check('network throw is swallowed', threw, false);
  check('network throw reports not-sent', r.sent, false);
}

/* ------------------------------------------------ userEmail */
{
  globalThis.fetch = async () => new Response(JSON.stringify({ email: 'seller@example.com' }), { status: 200 });
  check('userEmail returns the address', await userEmail(BASE, 'user-1'), 'seller@example.com');
}
{
  globalThis.fetch = async () => new Response('nope', { status: 404 });
  check('userEmail returns null on 404 rather than throwing', await userEmail(BASE, 'user-1'), null);
}
{
  globalThis.fetch = async () => { throw new Error('boom'); };
  check('userEmail returns null when the lookup throws', await userEmail(BASE, 'user-1'), null);
}
{
  check('userEmail with no id returns null', await userEmail(BASE, null), null);
  check('userEmail with no config returns null', await userEmail({}, 'user-1'), null);
}

globalThis.fetch = realFetch;

/* ------------------------------------------------ escaping in templates
 * Seller-supplied titles go into HTML email. Same rule as the rest of the
 * project: escape at the point of insertion. */
{
  check('escapeHtml handles the dangerous five',
        escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
  check('escapeHtml on null is empty', escapeHtml(null), '');

  const evil = '<img src=x onerror=alert(1)>';
  const r = buyerReceipt({ listingTitle: evil, amountCents: 14900, license: 'single',
                           siteUrl: 'https://forkable.dev', refundDays: 14 });
  check('buyer receipt escapes the title in HTML', r.html.includes('<img src=x'), false);
  ok('buyer receipt still shows the title as text', r.text.includes(evil));

  const s2 = sellerSale({ listingTitle: evil, amountCents: 14900, feeCents: 2235,
                          siteUrl: 'https://forkable.dev', refundDays: 14 });
  check('seller sale escapes the title in HTML', s2.html.includes('<img src=x'), false);
}

/* ------------------------------------------------ template arithmetic
 * The seller's net is the number they will check against their bank. */
{
  const s = sellerSale({ listingTitle: 'Guard Scheduler', amountCents: 14900,
                         feeCents: 2235, siteUrl: 'https://forkable.dev', refundDays: 14 });
  ok('sale email shows the gross', s.text.includes('$149'));
  ok('sale email shows the fee', s.text.includes('$22.35'));
  ok('sale email shows the net', s.text.includes('$126.65'));
  ok('sale email names the listing in the subject', s.subject.includes('Guard Scheduler'));
  ok('sale email explains the hold', /held until/i.test(s.text));
}
{
  const r = buyerReceipt({ listingTitle: 'Lead Scout', amountCents: 9900,
                           license: 'extended', siteUrl: 'https://forkable.dev', refundDays: 14 });
  ok('receipt marks an extended licence', /extended/i.test(r.text));
  ok('receipt tells the buyer refunds are self-service', /refund it yourself/i.test(r.text));
  ok('receipt states the window', r.text.includes('14 days'));
}
{
  const b = buyerRefunded({ listingTitle: 'RECONSOLE', amountCents: 12900 });
  ok('buyer refund names the amount', b.text.includes('$129'));
  const s = sellerRefunded({ listingTitle: 'RECONSOLE', amountCents: 12900 });
  ok('seller refund makes clear nothing is clawed back', /nothing is being taken back/i.test(s.text));
}
{
  const d = demoBroken({ listingTitle: 'Guard Scheduler', demoUrl: 'https://demo.example.com',
                         failures: 2, siteUrl: 'https://forkable.dev' });
  ok('demo alert names the listing', d.subject.includes('Guard Scheduler'));
  ok('demo alert includes the url', d.text.includes('https://demo.example.com'));
  ok('demo alert says why it matters', /before paying/i.test(d.text));
}

/* ------------------------------------------------ report */
if (fail) {
  console.log(`\n  ${pass} passed, ${fail} FAILED`);
  process.exit(1);
}
console.log(`  ${pass} assertions passed`);
