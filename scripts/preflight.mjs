#!/usr/bin/env node
/* Forkable preflight — run before trusting a deployment with real money.
 *
 *   node scripts/preflight.mjs
 *
 * Reads .dev.vars and checks the things that are silent when wrong and expensive
 * when discovered late: missing tables, RLS that isn't actually stopping anyone,
 * repo_url readable by the public, a Stripe account that can't accept charges.
 *
 * Read-only. It never writes to your database or moves money.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || join(ROOT, '.dev.vars');

let pass = 0, warn = 0, failed = 0;
const ok   = (m, d) => { pass++;   console.log(`  \x1b[32m✔\x1b[0m ${m}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`); };
const bad  = (m, d) => { failed++; console.log(`  \x1b[31m✘\x1b[0m ${m}${d ? `\n      \x1b[2m${d}\x1b[0m` : ''}`); };
const meh  = (m, d) => { warn++;   console.log(`  \x1b[33m!\x1b[0m ${m}${d ? `\n      \x1b[2m${d}\x1b[0m` : ''}`); };
const head = (m)    => console.log(`\n\x1b[1m${m}\x1b[0m`);

if (!existsSync(FILE)) {
  console.error(`No ${FILE}. Copy .dev.vars.example to .dev.vars and fill it in.`);
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const PLACEHOLDER = /placeholder|YOUR-PROJECT|^eyJ\.\.\.$|generate-a-long|^sk_test_placeholder$/i;

/* ------------------------------------------------------------------ env */
head('Environment');
const REQUIRED = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SITE_URL', 'CRON_SECRET'
];
let stillPlaceholder = false;
for (const k of REQUIRED) {
  if (!env[k]) bad(`${k} is missing`);
  else if (PLACEHOLDER.test(env[k])) { meh(`${k} is still a placeholder`); stillPlaceholder = true; }
  else ok(k);
}

if (env.SUPABASE_ANON_KEY && env.SUPABASE_ANON_KEY === env.SUPABASE_SERVICE_ROLE_KEY) {
  bad('SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are identical',
      'One of them is pasted wrong. The service_role key bypasses every policy.');
}
if (env.CRON_SECRET && env.CRON_SECRET.length < 24 && !PLACEHOLDER.test(env.CRON_SECRET)) {
  meh('CRON_SECRET is short', 'Anyone who guesses it can trigger payouts early. Use 32+ random chars.');
}
if (env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
  meh('Using a LIVE Stripe key', 'Real cards will be charged. Use sk_test_ until the whole loop works.');
}

/* Demo isolation — the gate before strangers can list.
 *
 * Not a payments problem, which is exactly why it gets said out loud here:
 * nothing else in this script would ever notice. Checked before the early exit
 * below because it reads a local file and needs no network. See ROADMAP.md,
 * Stage 3. */
head('Demo isolation');
{
  const cfg = existsSync('config.js') ? readFileSync('config.js', 'utf8') : '';
  const m = cfg.match(/demoOrigin\s*:\s*'([^']*)'/);
  const demoOrigin = m ? m[1].trim() : null;
  const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');

  if (demoOrigin === null) {
    meh('config.js has no demoOrigin setting',
      'Demos stay on the app origin until you add it.');
  } else if (!demoOrigin) {
    meh('demoOrigin is blank — first-party demos share the app origin',
      'Fine while every demo in demos/ is your own code. Point it at a separate\n      origin (e.g. https://demos.yourdomain.com) BEFORE accepting a seller demo.');
  } else if (siteUrl && demoOrigin.replace(/\/$/, '') === siteUrl) {
    bad('demoOrigin is the same origin as SITE_URL',
      'That defeats the point — a seller demo could reach into the app page.\n      Use a genuinely different origin.');
  } else {
    ok('Demos are served from a separate origin', demoOrigin);
  }
}

/* ------------------------------------------------ launch readiness */
head('Launch readiness');

const legal = ['terms.html', 'privacy.html'].filter((f) => !existsSync(f));
if (legal.length) {
  bad('Missing legal pages: ' + legal.join(', '),
      'Stripe asks for published terms and a privacy policy before enabling live\n' +
      '      payments, and a marketplace with neither reads as untrustworthy.');
} else {
  ok('Terms and privacy policy published');
}

const cfgText = existsSync('config.js') ? readFileSync('config.js', 'utf8') : '';
const analyticsMatch = cfgText.match(/analyticsToken\s*:\s*'([^']*)'/);
if (!analyticsMatch || !analyticsMatch[1].trim()) {
  meh('No analytics configured',
      'You cannot measure a launch you did not instrument, and the number that\n' +
      '      matters most here -- how many visitors click into a demo -- is invisible\n' +
      '      without it. Set analyticsToken in config.js BEFORE traffic arrives.');
} else {
  ok('Analytics configured');
}

/* Anything past here needs to actually reach the services. */
if (stillPlaceholder) {
  console.log('\n\x1b[33mPlaceholders present — skipping live checks.\x1b[0m');
  summary({ incomplete: true });
}

const SB = env.SUPABASE_URL.replace(/\/$/, '');

async function sb(path, { key = env.SUPABASE_ANON_KEY, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${SB}/rest/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}

/* -------------------------------------------------------------- schema */
head('Supabase schema');
let supabaseUp = false;
try {
  const probe = await fetch(`${SB}/rest/v1/`, { headers: { apikey: env.SUPABASE_ANON_KEY } });
  if (probe.ok || probe.status === 200) { ok('Project reachable', SB); supabaseUp = true; }
  else bad(`Project responded ${probe.status}`, 'Check SUPABASE_URL and the anon key.');
} catch (e) {
  bad('Could not reach Supabase', e.message);
}

// Stripe is independent of Supabase — a database outage should not hide whether
// payments are configured, so the rest is skipped rather than the run aborted.
if (!supabaseUp) console.log('  \x1b[2mSkipping schema and security checks — no connection.\x1b[0m');

for (const t of supabaseUp
  ? ['waitlist', 'profiles', 'listings', 'purchases', 'reviews',
     'sandbox_instances', 'platform_settings', 'listing_updates',
     'requests', 'request_responses', 'import_usage']
  : []) {
  const r = await sb(`/${t}?select=*&limit=1`, { key: env.SUPABASE_SERVICE_ROLE_KEY });
  if (r.status === 404 || r.json?.code === '42P01') bad(`Table "${t}" missing`, 'Run the SQL files in supabase/ in order.');
  else if (r.ok) ok(`Table "${t}"`);
  else meh(`Table "${t}" responded ${r.status}`, r.json?.message || r.text.slice(0, 90));
}

for (const v of supabaseUp
  ? ['listings_with_seller', 'payouts_due', 'seller_earnings',
     'listing_ratings', 'reviews_public', 'seller_public', 'listing_update_summary',
     'requests_public', 'request_responses_public']
  : []) {
  const r = await sb(`/${v}?select=*&limit=1`, { key: env.SUPABASE_SERVICE_ROLE_KEY });
  if (r.ok) ok(`View "${v}"`);
  else bad(`View "${v}" missing or broken`, r.json?.message || `HTTP ${r.status}`);
}

/* The fix for a leaked column, written out once.
 *
 * `revoke select (col) on tbl from anon` looks right and does nothing: a
 * TABLE-level select grant implies every column, and a column-level revoke
 * cannot subtract from it. Supabase grants anon/authenticated table-level
 * select on new public tables, so the one-liner reports success and the column
 * stays readable. Drop the table grant, then grant back what is public.
 */
const colFix = (table, secret) =>
  `A column-level revoke will NOT fix this — it is a silent no-op while the\n` +
  `      table-level grant exists. Run this instead:\n` +
  `      do $$ declare cols text; begin\n` +
  `        select string_agg(quote_ident(column_name), ', ' order by ordinal_position)\n` +
  `          into cols from information_schema.columns\n` +
  `        where table_schema='public' and table_name='${table}'\n` +
  `          and column_name not in (${secret});\n` +
  `        execute 'revoke select on public.${table} from anon, authenticated';\n` +
  `        execute format('grant select (%s) on public.${table} to anon, authenticated', cols);\n` +
  `      end $$;\n` +
  `      Then confirm: select has_column_privilege('anon','public.${table}',<col>,'SELECT'); -- false`;

/* ------------------------------------------------------------ security */
head('Security (these are the ones that cost you money)');
if (!supabaseUp) console.log('  \x1b[2mSkipped — no connection to Supabase.\x1b[0m');
if (supabaseUp) {

// The big one: repo_url is the product. Public read = every template is free.
const repoLeak = await sb('/listings?select=repo_url&limit=1');
if (repoLeak.ok && Array.isArray(repoLeak.json)) {
  // Not "re-run schema.sql": the later files change listings_with_seller's column
  // list, and CREATE OR REPLACE VIEW cannot reorder columns, so that script now
  // aborts partway with a confusing error. Give the one statement that fixes it.
  bad('PUBLIC CAN READ repo_url',
      'Column privileges were not applied. ' + colFix('listings', "'repo_url'"));
} else {
  ok('repo_url is not publicly readable', `anon got ${repoLeak.status}`);
}

/* The one route that spends real money on every call. A cap that is not installed
 * is not a cap, and this is the failure mode where you find out from a bill. */
if (env.ANTHROPIC_API_KEY) {
  const quota = await sb('/rpc/claim_import_quota', {
    method: 'POST', body: { p_user: '00000000-0000-4000-8000-000000000000' },
    key: env.SUPABASE_SERVICE_ROLE_KEY
  });
  if (quota.status === 404 || quota.json?.code === '42883') {
    bad('ANTHROPIC_API_KEY is set but the import spend cap is NOT installed',
        'One account can loop /api/import-repo and drain the key. Run:\n' +
        '      supabase/import_quota.sql\n' +
        '      ...or unset ANTHROPIC_API_KEY, which disables that one button and nothing else.');
  } else {
    ok('Import spend cap is installed', 'claim_import_quota responded');
  }
  meh('ANTHROPIC_API_KEY is set',
      'The daily cap bounds CALLS, not dollars. Set a hard spend cap in the Anthropic\n' +
      '      console as well — a cap in one place only is how a key gets drained.');
} else {
  ok('ANTHROPIC_API_KEY unset', 'Auto-draft is off; nothing can spend on the model.');
}

/* Email. Not having it is a real product hole rather than a config nicety: a
 * seller who is never told they made a sale has no reason to come back. */
if (env.RESEND_API_KEY) {
  if (!env.MAIL_FROM) {
    meh('RESEND_API_KEY set but MAIL_FROM is not',
        'Mail will go out from the Resend sandbox sender, which lands in spam for\n' +
        '      most recipients. Verify a domain in Resend and set MAIL_FROM.');
  } else {
    ok('Transactional email configured', env.MAIL_FROM);
  }
  if (!env.SUPPORT_EMAIL) {
    meh('No SUPPORT_EMAIL',
        'Replies to your receipts go nowhere. A buyer whose payment breaks has no\n' +
        '      way to reach a human.');
  }
} else {
  meh('RESEND_API_KEY unset — no email is sent at all',
      'Sellers are not told when they make a sale, buyers get no receipt, and a\n' +
      '      broken demo alerts nobody. Fine for local work; not fine at launch.');
}

// A browser must never be able to mint itself a completed purchase.
const fakeBuy = await sb('/purchases', {
  method: 'POST',
  body: { listing_id: '00000000-0000-4000-8000-000000000000',
          buyer_id: '00000000-0000-4000-8000-000000000000',
          amount_cents: 1, status: 'complete' }
});
if (fakeBuy.ok) bad('ANON CAN INSERT PURCHASES', 'Anyone can unlock every repo for free. Re-run schema.sql.');
else ok('Anonymous cannot create purchases', `HTTP ${fakeBuy.status}`);

// Drafts belong to their seller only — check the table...
const drafts = await sb('/listings?select=id,status&status=eq.draft&limit=1');
if (drafts.ok && drafts.json?.length) bad('Draft listings are publicly visible', 'The select policy is wrong.');
else ok('Drafts are not publicly listed (table)');

// ...and the view the app actually reads. A view without security_invoker runs as
// its owner and silently bypasses RLS, which is exactly how drafts leaked before.
const draftsView = await sb('/listings_with_seller?select=id,status&status=eq.draft&limit=1');
if (draftsView.ok && draftsView.json?.length) {
  bad('Drafts leak through listings_with_seller',
      'The view is missing security_invoker = on. Run supabase/reviews_and_health.sql.');
} else {
  ok('Drafts are not visible through the view');
}

// Same class of bug one table over: "profiles are public" is `using (true)`, so
// the Stripe columns are only private if they are revoked at the column level.
const connectLeak = await sb('/profiles?select=stripe_connect_id&limit=1');
if (connectLeak.ok) {
  bad('PUBLIC CAN READ stripe_connect_id',
      'Every seller\'s Connect account id is exposed. ' +
      colFix('profiles', "'stripe_connect_id','stripe_charges_enabled'," +
                         "'stripe_payouts_enabled','stripe_details_submitted'"));
} else {
  ok('stripe_connect_id is not publicly readable', `anon got ${connectLeak.status}`);
}

const connectFlagLeak = await sb('/profiles?select=stripe_charges_enabled&limit=1');
if (connectFlagLeak.ok) {
  bad('PUBLIC CAN READ Stripe onboarding flags',
      colFix('profiles', "'stripe_connect_id','stripe_charges_enabled'," +
                         "'stripe_payouts_enabled','stripe_details_submitted'"));
} else {
  ok('Stripe onboarding flags are not publicly readable', `anon got ${connectFlagLeak.status}`);
}

// Health data is written by the checker, never by a seller marking their own
// broken demo as fine.
const healthWrite = await sb('/sandbox_instances', {
  method: 'POST',
  body: { listing_id: '00000000-0000-4000-8000-000000000000', status: 'live' }
});
if (healthWrite.ok) bad('ANON CAN WRITE DEMO HEALTH', 'Re-run supabase/reviews_and_health.sql.');
else ok('Anonymous cannot forge demo health', `HTTP ${healthWrite.status}`);

const settings = await sb('/platform_settings?select=platform_fee_bps,refund_window_days&limit=1');
if (settings.ok && settings.json?.[0]) {
  const s = settings.json[0];
  ok('Platform settings readable', `fee ${(s.platform_fee_bps / 100).toFixed(1)}%, window ${s.refund_window_days} days`);
} else {
  meh('Could not read platform_settings', 'Checkout falls back to 15% / 14 days.');
}

} // end supabaseUp

/* -------------------------------------------------------------- stripe */
head('Stripe');
async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

const acct = await stripeGet('/account');
if (!acct.ok) {
  bad(`Stripe rejected the key (HTTP ${acct.status})`, acct.json?.error?.message);
} else {
  const a = acct.json;
  ok('Stripe key valid', `${a.id}${a.settings?.dashboard?.display_name ? ` — ${a.settings.dashboard.display_name}` : ''}`);
  if (a.charges_enabled) ok('Platform can accept charges');
  else bad('Platform cannot accept charges yet', 'Finish the Stripe account activation.');

  // Connect is the whole two-sided model; without it there are no sellers.
  const conn = await stripeGet('/accounts?limit=1');
  if (conn.ok) ok('Connect is enabled', `${conn.json?.data?.length ?? 0} connected account(s)`);
  else bad('Connect does not appear to be enabled', conn.json?.error?.message ||
        'Enable Connect and complete the platform profile in the Stripe dashboard.');
}

if (env.STRIPE_WEBHOOK_SECRET && !env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
  bad('STRIPE_WEBHOOK_SECRET does not start with whsec_', 'That is probably the wrong value.');
} else if (env.STRIPE_WEBHOOK_SECRET) {
  ok('Webhook secret looks well-formed');
}

summary();

function summary({ incomplete = false } = {}) {
  console.log(`\n\x1b[1m${pass} passed, ${warn} warning(s), ${failed} failed\x1b[0m`);
  if (failed) {
    console.log('\x1b[31mDo not take real payments until the failures above are fixed.\x1b[0m');
    process.exit(1);
  }
  if (incomplete) {
    // Never report "ready" for a config we could not actually exercise.
    console.log('\x1b[33mNot configured yet — fill in .dev.vars, then run this again.\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mReady. Run the whole loop once in Stripe test mode before going live.\x1b[0m');
  process.exit(0);
}
