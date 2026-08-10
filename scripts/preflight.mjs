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

for (const t of supabaseUp ? ['waitlist', 'profiles', 'listings', 'purchases', 'reviews', 'sandbox_instances', 'platform_settings'] : []) {
  const r = await sb(`/${t}?select=*&limit=1`, { key: env.SUPABASE_SERVICE_ROLE_KEY });
  if (r.status === 404 || r.json?.code === '42P01') bad(`Table "${t}" missing`, 'Run the SQL files in supabase/ in order.');
  else if (r.ok) ok(`Table "${t}"`);
  else meh(`Table "${t}" responded ${r.status}`, r.json?.message || r.text.slice(0, 90));
}

for (const v of supabaseUp ? ['listings_with_seller', 'payouts_due', 'seller_earnings'] : []) {
  const r = await sb(`/${v}?select=*&limit=1`, { key: env.SUPABASE_SERVICE_ROLE_KEY });
  if (r.ok) ok(`View "${v}"`);
  else bad(`View "${v}" missing or broken`, r.json?.message || `HTTP ${r.status}`);
}

/* ------------------------------------------------------------ security */
head('Security (these are the ones that cost you money)');
if (!supabaseUp) console.log('  \x1b[2mSkipped — no connection to Supabase.\x1b[0m');
if (supabaseUp) {

// The big one: repo_url is the product. Public read = every template is free.
const repoLeak = await sb('/listings?select=repo_url&limit=1');
if (repoLeak.ok && Array.isArray(repoLeak.json)) {
  bad('PUBLIC CAN READ repo_url', 'Column privileges were not applied. Re-run supabase/schema.sql.');
} else {
  ok('repo_url is not publicly readable', `anon got ${repoLeak.status}`);
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

// Drafts belong to their seller only.
const drafts = await sb('/listings?select=id,status&status=eq.draft&limit=1');
if (drafts.ok && drafts.json?.length) bad('Draft listings are publicly visible', 'The select policy is wrong.');
else ok('Drafts are not publicly listed');

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
