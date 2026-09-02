/* The localStorage backend's access rules, tested.
 *
 * WHY THIS FILE EXISTS — scar #2, stated the other way round.
 *
 * app/db.js is one interface over two backends. The Supabase one is guarded by
 * RLS policies and column privileges in supabase/*.sql; the localStorage one
 * re-implements those same rules in JavaScript so the whole app runs with zero
 * accounts. Nothing tested that JavaScript. The comments in db.js say "matches
 * the select policy" and "mirrors listing_repo_url()", and until now that was an
 * assertion in a comment rather than an assertion in a test.
 *
 * That matters in both directions:
 *
 *   local MORE permissive than the SQL  -> the mock lies. Tests go green while
 *                                          the real database would refuse, or
 *                                          worse, while it would leak.
 *   local LESS permissive than the SQL  -> features look broken in local mode
 *                                          and get "fixed" by loosening the
 *                                          wrong side.
 *
 * These tests pin the rules that have a security meaning. They do NOT prove the
 * database enforces anything — only supabase/*.sql run against Postgres can do
 * that (see ROADMAP "Scars"). What they prove is that the mock has not drifted
 * away from what the SQL says, which is the part that silently rots.
 *
 * Run: node app/local-rules.test.mjs
 */
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('./db.js', import.meta.url), 'utf8');
const APP_ORIGIN = 'https://forkable.pages.dev';

/* A fresh, isolated app instance: own localStorage, own DB. */
function boot() {
  const store = {};
  const g = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    location: { origin: APP_ORIGIN, href: APP_ORIGIN + '/app.html' },
    FORKABLE_CONFIG: { supabaseUrl: '', supabaseAnonKey: '', demoOrigin: '' },
    // db.js hashes passwords with crypto.subtle, so the real WebCrypto has to be
    // here — a stub would quietly change what "signed in" means in these tests.
    crypto: {
      randomUUID: () => 'id-' + Math.random().toString(36).slice(2, 12),
      subtle: globalThis.crypto.subtle,
      getRandomValues: (a) => globalThis.crypto.getRandomValues(a)
    },
    TextEncoder,
    URL,
    fetch: () => Promise.reject(new Error('no network in tests')),
    console
  };
  g.window = g;
  new Function('window', 'localStorage', 'location', 'crypto', 'URL', 'fetch', 'console', SRC)
    .call(g, g, g.localStorage, g.location, g.crypto, URL, g.fetch, console);
  return g.DB;
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) pass++;
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${expected}, got ${actual}`); }
}
function ok(label, cond) { check(label, !!cond, true); }
async function refuses(label, promise) {
  try { await promise; check(label, 'resolved', 'rejected'); }
  catch { pass++; }
}

const DB = boot();

/* Two sellers and a buyer, so "someone else's" is a real other account. */
await DB.signUp('alice@example.com', 'pw-alice-123', 'Alice', 'seller');
const alice = DB.currentUser().id;
await DB.signOut();
await DB.signUp('mallory@example.com', 'pw-mallory-123', 'Mallory', 'seller');
const mallory = DB.currentUser().id;
await DB.signOut();
await DB.signUp('bob@example.com', 'pw-bob-123', 'Bob', 'buyer');
const bob = DB.currentUser().id;
await DB.signOut();

/* Alice publishes one live listing and keeps one draft. */
await DB.signIn('alice@example.com', 'pw-alice-123');
const live = await DB.createListing({
  title: 'Guard Scheduler', short_description: 'Shifts.', long_description: 'Longer.',
  category: 'scheduling', price_cents: 14900, status: 'live',
  demo_url: 'https://demo.example.com/guard', repo_url: 'https://github.com/alice/guard',
  tech_stack_tags: ['JS']
});
const draft = await DB.createListing({
  title: 'Secret WIP', short_description: 'Not ready.', long_description: '',
  category: 'other', price_cents: 9900, status: 'draft',
  repo_url: 'https://github.com/alice/secret'
});
await DB.signOut();

/* ---------------------------------------------- listing visibility
 * SQL: create policy "live listings are public" ... using (status = 'live' or seller_id = auth.uid()) */
{
  const anonList = await DB.listListings();
  check('anon sees the live listing', anonList.some((l) => l.id === live.id), true);
  check('anon does NOT see the draft', anonList.some((l) => l.id === draft.id), false);
  check('anon cannot open the draft directly', await DB.getListing(draft.id), null);

  await DB.signIn('mallory@example.com', 'pw-mallory-123');
  const asOther = await DB.listListings();
  check('another seller does NOT see the draft', asOther.some((l) => l.id === draft.id), false);
  check('another seller cannot open the draft directly', await DB.getListing(draft.id), null);
  await DB.signOut();

  await DB.signIn('alice@example.com', 'pw-alice-123');
  const own = await DB.getListing(draft.id);
  check('the owner CAN open their own draft', own && own.id === draft.id, true);
  await DB.signOut();
}

/* ---------------------------------------------- repo_url
 * SQL: revoke select (repo_url) + listing_repo_url() — seller or completed buyer only.
 * repo_url is the product. Anyone who can read it for free has taken it. */
{
  const anonView = await DB.getListing(live.id);
  check('anon cannot read repo_url', anonView.repo_url === undefined, true);

  await DB.signIn('mallory@example.com', 'pw-mallory-123');
  const otherView = await DB.getListing(live.id);
  check('a signed-in non-buyer cannot read repo_url', otherView.repo_url === undefined, true);
  await DB.signOut();

  await DB.signIn('alice@example.com', 'pw-alice-123');
  const sellerView = await DB.getListing(live.id);
  check('the seller CAN read their own repo_url', !!sellerView.repo_url, true);
  await DB.signOut();
}

/* ---------------------------------------------- demo_url / has_demo
 * SQL: demo_gate.sql — demo_url revoked like repo_url; has_demo is public.
 * Infinite free use is stopped by the trial gate, not by hiding that a demo exists. */
{
  const anonView = await DB.getListing(live.id);
  check('anon sees has_demo', !!anonView.has_demo, true);
  check('anon cannot read demo_url', anonView.demo_url === undefined, true);

  await DB.signIn('mallory@example.com', 'pw-mallory-123');
  const otherView = await DB.getListing(live.id);
  check('a signed-in non-buyer cannot read demo_url', otherView.demo_url === undefined, true);
  await DB.signOut();

  await DB.signIn('alice@example.com', 'pw-alice-123');
  const sellerView = await DB.getListing(live.id);
  check('the seller CAN read their own demo_url', !!sellerView.demo_url, true);
  await DB.signOut();
}

/* ---------------------------------------------- demo trial claim (local)
 * Mirrors claim_demo_session: one active trial; resume while unexpired. */
{
  const first = await DB.startDemoSession({ listingId: live.id });
  ok('anon can start a demo trial', first && first.ok && first.launch_url);
  const again = await DB.startDemoSession({ listingId: live.id });
  ok('active trial can be resumed', again && again.session_id === first.session_id);

  await DB.signIn('alice@example.com', 'pw-alice-123');
  const sellerSession = await DB.startDemoSession({ listingId: live.id });
  ok('seller trial is unlimited', sellerSession && sellerSession.unlimited === true);
  await DB.signOut();
}

/* ---------------------------------------------- writes belong to the owner
 * SQL: "sellers update own listings" / "sellers delete own listings" */
{
  await DB.signIn('mallory@example.com', 'pw-mallory-123');
  await refuses("another seller cannot edit Alice's listing",
    DB.updateListing(live.id, { title: 'Stolen' }));
  await refuses("another seller cannot delete Alice's listing",
    DB.deleteListing(live.id));
  await DB.signOut();

  const stillThere = await DB.getListing(live.id);
  check('the listing survived both attempts', stillThere.title, 'Guard Scheduler');
}

/* ---------------------------------------------- buying
 * SQL/route: a seller cannot buy their own listing; no double purchase. */
{
  await DB.signIn('alice@example.com', 'pw-alice-123');
  await refuses('a seller cannot buy their own listing', DB.startCheckout(live.id, 'single'));
  await DB.signOut();

  await DB.signIn('bob@example.com', 'pw-bob-123');
  const p = await DB.startCheckout(live.id, 'single');
  check('a buyer can buy a live listing', !!p, true);
  await refuses('the same buyer cannot buy it twice', DB.startCheckout(live.id, 'single'));

  const bought = await DB.getListing(live.id);
  check('after buying, the buyer CAN read repo_url', !!bought.repo_url, true);
  check('after buying, the buyer CAN read demo_url', !!bought.demo_url, true);
  const bag = await DB.myPurchases();
  check('purchases page listing includes repo_url',
        !!(bag[0] && bag[0].listing && bag[0].listing.repo_url), true);
  const buyerDemo = await DB.startDemoSession({ listingId: live.id });
  ok('buyer demo session is unlimited', buyerDemo && buyerDemo.unlimited === true);
  const walk = await DB.deployGuide(live.id, 'cloudflare');
  ok('buyer can get a deploy walkthrough', walk && walk.guide && walk.guide.steps.length > 0);
  await DB.signOut();
  let denied = false;
  try { await DB.deployGuide(live.id, 'cloudflare'); } catch (e) { denied = /sign in|buy this/i.test(e.message); }
  await DB.signIn('mallory@example.com', 'pw-mallory-123');
  try { await DB.deployGuide(live.id, 'cloudflare'); } catch (e) { denied = denied || /buy this/i.test(e.message); }
  ok('non-buyer cannot get a deploy walkthrough', denied);
  await DB.signOut();

  // ...and nobody else gained anything by Bob's purchase.
  const anonAfter = await DB.getListing(live.id);
  check('anon still cannot read repo_url after someone else bought', anonAfter.repo_url === undefined, true);
  check('anon still cannot read demo_url after someone else bought', anonAfter.demo_url === undefined, true);
}

/* ---------------------------------------------- purchases are private
 * SQL: "buyer or seller can read purchase" */
{
  await DB.signIn('mallory@example.com', 'pw-mallory-123');
  const theirs = await DB.myPurchases();
  check("another user sees none of Bob's purchases", theirs.length, 0);
  await DB.signOut();

  await DB.signIn('bob@example.com', 'pw-bob-123');
  const mine = await DB.myPurchases();
  check('the buyer sees their own purchase', mine.length, 1);
  await DB.signOut();
}

/* ---------------------------------------------- refunds
 * SQL/route: only the buyer of that purchase, and buyer-favourable by design. */
{
  await DB.signIn('bob@example.com', 'pw-bob-123');
  const [purchase] = await DB.myPurchases();
  await DB.signOut();

  await DB.signIn('mallory@example.com', 'pw-mallory-123');
  await refuses("a stranger cannot refund someone else's purchase", DB.requestRefund(purchase.id));
  await DB.signOut();

  await DB.signIn('alice@example.com', 'pw-alice-123');
  await refuses('the SELLER cannot refund the buyer\'s purchase', DB.requestRefund(purchase.id));
  await DB.signOut();

  await DB.signIn('bob@example.com', 'pw-bob-123');
  const refunded = await DB.requestRefund(purchase.id);
  check('the buyer CAN refund their own purchase', !!refunded, true);
  await DB.signOut();
}

/* ---------------------------------------------- CHECK constraint parity
 * SQL: listings.price_cents >= 0
 *      listings_extended_price_check: extended is null or extended > price
 * Postgres refuses these rows, so local mode must too — otherwise local reaches
 * states production cannot, and a bug found in prod is unreproducible locally. */
{
  await DB.signIn('alice@example.com', 'pw-alice-123');

  await refuses('local refuses a negative price, as Postgres does',
    DB.createListing({ title: 'Bad', short_description: 'x', category: 'other',
                       price_cents: -5000, status: 'draft' }));

  await refuses('local refuses an extended price below the base price',
    DB.createListing({ title: 'Bad tier', short_description: 'x', category: 'other',
                       price_cents: 10000, extended_price_cents: 5000, status: 'draft' }));

  await refuses('local refuses an extended price EQUAL to the base price',
    DB.createListing({ title: 'Equal tier', short_description: 'x', category: 'other',
                       price_cents: 10000, extended_price_cents: 10000, status: 'draft' }));

  const good = await DB.createListing({
    title: 'Good tier', short_description: 'x', category: 'other',
    price_cents: 10000, extended_price_cents: 25000, status: 'draft' });
  check('local accepts a valid extended tier', !!good, true);

  await refuses('an UPDATE cannot sneak past the constraint either',
    DB.updateListing(good.id, { extended_price_cents: 1 }));

  const unchanged = await DB.getListing(good.id);
  check('the rejected update did not partially apply',
        unchanged.extended_price_cents, 25000);

  await DB.signOut();
}

/* ---------------------------------------------- signed-out writes
 * Every one of these is `to authenticated` in the SQL. */
{
  await refuses('anon cannot create a listing', DB.createListing({ title: 'x', price_cents: 1 }));
  await refuses('anon cannot buy', DB.startCheckout(live.id, 'single'));
}

/* ---------------------------------------------- moderation
 * SQL: is_admin() gates the queue; admin_set_listing_status() re-checks it and
 * can write only `status`. Local mode makes the first account the admin so the
 * screen is reachable without hand-editing storage — Alice, here.
 *
 * The rule that actually matters: a non-admin must get nothing and be able to
 * change nothing, even though the UI simply hides the link. Hiding a control is
 * not a security boundary; this is what makes it one. */
{
  await DB.signIn('mallory@example.com', 'pw-mallory-123');
  check('a normal seller is not an admin', await DB.isAdmin(), false);
  check('a non-admin sees an empty moderation queue', (await DB.moderationQueue()).length, 0);
  await refuses('a non-admin cannot delist anything',
    DB.setListingStatus(live.id, 'delisted', 'because I feel like it'));
  check('a non-admin sees no moderation log', (await DB.moderationLog()).length, 0);
  await DB.signOut();

  check('a signed-out visitor is not an admin', await DB.isAdmin(), false);
  await refuses('a signed-out visitor cannot delist',
    DB.setListingStatus(live.id, 'delisted', null));

  // ...and the listing survived every one of those attempts.
  const survived = await DB.getListing(live.id);
  check('the listing is still live after all of that', survived.status, 'live');
}

{
  await DB.signIn('alice@example.com', 'pw-alice-123');
  check('the first account IS an admin in local mode', await DB.isAdmin(), true);

  const queue = await DB.moderationQueue();
  ok('the admin queue is not empty', queue.length > 0);
  ok('the queue includes drafts, not just live listings',
     queue.some((r) => r.status === 'draft'));
  ok('the queue carries the seller name for context',
     queue.every((r) => typeof r.seller_name === 'string'));

  await DB.setListingStatus(live.id, 'delisted', 'testing the takedown');
  const gone = await DB.getListing(live.id);
  check('an admin can delist a listing', gone.status, 'delisted');

  const log = await DB.moderationLog();
  check('the action was written to the log', log.length, 1);
  check('the log records the new status', log[0].new_status, 'delisted');
  check('the log records the reason', log[0].reason, 'testing the takedown');

  await DB.setListingStatus(live.id, 'live', null);
  check('an admin can restore it', (await DB.getListing(live.id)).status, 'live');
  check('an empty reason is stored as null, not an empty string',
        (await DB.moderationLog())[0].reason, null);
  await DB.signOut();
}

/* A delisted listing must fall out of public view — the whole point of delisting. */
{
  await DB.signIn('alice@example.com', 'pw-alice-123');
  await DB.setListingStatus(live.id, 'delisted', 'checking visibility');
  await DB.signOut();

  const publicList = await DB.listListings();
  check('a delisted listing disappears from the public list',
        publicList.some((l) => l.id === live.id), false);

  await DB.signIn('alice@example.com', 'pw-alice-123');
  await DB.setListingStatus(live.id, 'live', null);
  await DB.signOut();
}

/* ---------------------------------------------- live-backend query shape
 * Column-revoked fields (stripe_*, is_admin, repo_url, demo_url) make
 * `select=*` a permission denied for the whole row. Pin the queries. */
{
  check('myProfile lists public columns',
        /profiles\?select=id,display_name,role,bio,created_at/.test(SRC), true);
  check('myProfile does not select *', /profiles\?select=\*/.test(SRC), false);
  check('createListing uses return=minimal',
        /createListing:[\s\S]*?Prefer': 'return=minimal'/.test(SRC), true);
  ok('live purchases hydrate repo via RPC',
     /purchases\?select=\*,listing:listings_with_seller\(\*\)[\s\S]{0,500}repoUrl/.test(SRC));
}

/* ---------------------------------------------- report */
if (fail) {
  console.log(`\n  ${pass} passed, ${fail} FAILED`);
  process.exit(1);
}
console.log(`  ${pass} assertions passed`);
