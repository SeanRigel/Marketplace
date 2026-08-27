# Forkable

A builder-to-builder marketplace for reusable operational tools. Every listing is a
running app you can use before you pay, ships as a fork-and-deploy template, and is
covered by a refund window.

**Status: steps 0–5 done.** Validation landing page; auth, profiles, and listing CRUD;
Stripe Connect checkout with held payouts and a self-service refund window; reviews,
seller profiles, search and sort, and automated demo health checking.

> **Lost? Open [ROADMAP.md](ROADMAP.md)** — what's done, what's next, what's blocking,
> and which of these four files to read. This README explains how the code works; the
> roadmap explains where the project is.

---

## What's here

```
index.html              the landing page (vanilla, self-contained, no build step)
app.html                the app shell — #/browse, #/listing/<id>, #/auth, #/dashboard/*
app/db.js               data layer: Supabase backend | local backend, one interface
app/app.js              hash router + views
app/style.css           app styling (same tokens as the landing page)
config.js               brand + Supabase keys + the featured listing data
functions/api/*.js      Cloudflare Pages Functions — checkout, webhook, connect,
                        refund, release-payouts, check-demo(s)
functions/_shared/*.js  Stripe-over-fetch, Supabase server access, helpers
scripts/preflight.mjs   pre-deploy validation, including the security checks
supabase/waitlist.sql   waitlist table, unique index, RLS policy
supabase/schema.sql     profiles, listings, purchases, reviews, sandbox_instances + RLS
supabase/payments.sql   payout holds, fee settings, payouts_due + seller_earnings views
supabase/reviews_and_health.sql
                        ratings, seller profiles, demo health + a view security fix
supabase/changelog.sql  listing_updates + the "maintained?" summary view
supabase/licenses_and_requests.sql
supabase/import_quota.sql
supabase/moderation.sql
                        license tiers + the request board
demos/                  three real working apps, served as Phase 1 sandbox demos
```

### License tiers

Every listing can carry two prices: single-client and unlimited-client. The buyers
here are agencies deploying the same tool for several clients — it's the same work
for the seller and usually 3–4× the price, which is the model Envato and ThemeForest
run their whole business on.

The tier is chosen at checkout and **the amount is read from the database**, never
from the request body. Which licence was bought is stored on the purchase, because
the seller can re-price tomorrow and the sale shouldn't change retroactively.

### Request board

`#/requests` — buyers post what they need and what they'd pay; sellers reply publicly
and can attach one of their listings. One reply per seller per request, so it stays a
board rather than a pitch wall.

This exists because a marketplace with no catalogue gives a visitor nothing to do. It
also doubles as the most honest market research available: people stating what they'd
pay for. Read it before deciding what to build next.

### Draft a listing from a GitHub repo

`/api/import-repo` takes a public GitHub URL, reads the README through GitHub's API,
and asks Claude to draft the listing fields. The seller edits everything before saving
— nothing publishes automatically.

Notes on how it's built:
- **Structured outputs** (`output_config.format` with a JSON schema) rather than
  prompt-and-parse, so there's no "sometimes it wraps the JSON in prose" failure mode.
- `effort: 'low'` — drafting from a README isn't reasoning-heavy, and this keeps it
  fast and cheap.
- `stop_reason` is checked **before** reading content; a refusal returns HTTP 200 with
  empty content, so indexing `content[0]` would throw.
- Raw `fetch`, not the Anthropic SDK, for the same reason as Stripe: the SDK needs a
  bundler and this project has no build step.
- The model returns a `confidence` field and free-text `notes`; a low-confidence draft
  is surfaced to the seller as a warning rather than filled in silently.

**This is the only feature that spends money per click.** It needs `ANTHROPIC_API_KEY`,
and it's signed-in-only for exactly that reason. Set a spend limit in the Anthropic
console before adding the key. Leave the key unset and the feature stays off — the
listing form still works by hand.

### Listing changelogs

Reusable software isn't a static download — a seller fixes a bug or bumps a dependency
and, without this, nobody who already bought it ever finds out. Sellers post updates
from the listing page; buyers see **"N updates since you bought"** on their purchases,
and entries published after their purchase date are marked in the timeline.

It does double duty: before a sale it's evidence the template is maintained, which is
exactly what a technical buyer is trying to judge.

### Listing completeness meter

The seller form scores a listing live against eight checks. Two are hard gates because
they're the promises the marketplace actually makes to buyers — a working demo, and
setup docs good enough to deploy from. The rest is coaching, not enforcement. This is
what keeps the manual `pending_review` step cheap: most of what a human reviewer would
catch, the form catches first.

### Command palette

`⌘K` / `Ctrl+K` — jump to any route and search the catalog without loading the browse
page. The audience lives on a keyboard.

### Feeds

`/api/feed` (JSON Feed 1.1) and `/api/feed?fmt=rss`. Public, cached 10 minutes, served
through the anon key so RLS decides what's public rather than a hand-maintained column
list. Gives the catalog a surface that newsletters and bots can consume without
scraping a hash-routed SPA.

### Demo health checking

The product's whole claim is that every listing has a working demo. Demos rot — a
domain lapses, a free tier sleeps, a deploy breaks — and nothing else in the system
notices. `/api/check-demos` fetches every live listing's demo on a schedule and records
status, latency, and a consecutive-failure count in `sandbox_instances`.

Two deliberate choices: a demo is only marked `error` after **two** consecutive
failures, so one blip doesn't badge a seller's listing as broken; and it **never
auto-delists**, because how noisy real checks are is a thing to learn from data rather
than guess at. Sellers can also test a URL themselves from the listing form via
`/api/check-demo`.

### Why Pages Functions

Payments need server-side code — the Stripe secret key can never reach the browser.
The brief named Cloudflare Pages and Supabase, so this uses **Pages Functions**: it
ships with Pages, adds no new service or bill, and gives the webhook a public URL.
Supabase Edge Functions would have worked equally well but meant a second deploy
target. Stripe is called over plain `fetch` rather than the SDK, because the SDK
would force a bundler and the project is deliberately build-step-free.

### Routing

Hash-based (`app.html#/browse`) so the whole thing stays a static file with no build
step and no host rewrite rules. Swap to the History API plus a `_redirects` file when
clean URLs matter more than zero config.

### Local mode

With no Supabase keys in `config.js`, `app/db.js` falls back to a localStorage backend
implementing the same interface, seeded with the three real listings. Sign up, create
listings, edit, publish, delete — all of it works offline, and a cyan banner says so
rather than letting you think it's live. Fill in the keys and the same UI talks to
Postgres instead.

The local backend deliberately mirrors the RLS policies in `schema.sql`: drafts are
owner-only, `repo_url` is withheld unless you own or bought the listing, and you can't
edit another seller's listing. **If you change a policy in `schema.sql`, change the
matching guard in `db.js`** or the two modes will disagree about what a user can see.

The name `Forkable` is a placeholder. It lives in one constant in `config.js` and in
the nav/`<title>` of `index.html` — swap it whenever you land on a real name.

## Run it locally

```bash
python3 -m http.server 4321
```

Run it from the repo root, then open <http://localhost:4321>. It must be served over
HTTP, not opened as a `file://` path — the demo iframes won't load otherwise.

That serves the static site only. `/api/*` routes are Pages Functions and need
`npx wrangler pages dev .` instead.

## The demos are real

This is the part that matters. `demos/` contains working copies of three tools, and
the listing modal iframes them live:

| Listing | Demo | Notes |
| --- | --- | --- |
| Shift Scheduler | `demos/guard-scheduler/` | Full app; AI parse falls back to a built-in text reader with no key present |
| Lead Scout | `demos/lead-scout/` | Hits the real Overpass/OSM API — genuine results for any town |
| RECONSOLE | `demos/reconsole/` | Live DNS/RDAP/EXIF modules against real public endpoints |

All three were verified rendering inside the listing modal. No secrets were copied —
`guard-scheduler/.env` was deliberately left behind, and the sources were scanned for
key material before copying.

To re-sync a demo after editing the original tool:

```bash
cp ~/lead-scout/index.html ~/marketplace/demos/lead-scout/index.html
```

## Turning on the real backend

Right now signups and listings save to `localStorage` and the UI says so. To make it real:

1. Create a Supabase project.
2. Run `supabase/waitlist.sql`, then `supabase/schema.sql`, in the SQL editor.
3. Put the project URL and the **anon** key into `config.js`.

Auth email confirmation is on by default in Supabase. The signup flow handles the
no-session-yet case ("check your email, then sign in") rather than hanging — turn
confirmation off in Auth settings if you want instant signup while testing.

## Setting it up for real

**[SETUP.md](SETUP.md) is the walkthrough** — Supabase, Stripe Connect, deploy, and
the payout schedule, in order, with the failure modes for each. Check progress with:

```bash
node scripts/preflight.mjs
```

## Turning on payments

1. Run `supabase/payments.sql`.
2. In Stripe, enable **Connect** and complete the platform profile (see the lead-time
   note below — this is the slow part).
3. `cp .dev.vars.example .dev.vars` and fill it in. Set the same variables in the
   Cloudflare Pages dashboard for production.
4. Add a webhook endpoint pointing at `https://<your-domain>/api/webhook`, subscribed
   to `checkout.session.completed`, `charge.refunded`, and `account.updated`.
5. Run locally with `npx wrangler pages dev .` — the plain `python3 -m http.server`
   serves the static files but not `/api/*`.

Test the whole loop with Stripe test mode and card `4242 4242 4242 4242`.

### The payout hold

This is the guarantee, in code, and it's why checkout does **not** use a destination
charge:

- `checkout.js` charges onto the **platform** account with no `transfer_data`.
- The webhook writes the purchase with `refund_window_expires_at = now + 14 days`.
- Inside that window `refund.js` lets the buyer refund themselves — no approval, no
  dispute queue.
- Only once the window closes does `release-payouts.js` create the transfer to the
  seller's Connect account.

So a seller is genuinely unpaid while the buyer can still walk away. Swapping this for
a destination charge would make the promise unenforceable.

**Scheduling the payout sweep.** Pages Functions have no cron trigger, so
`/api/release-payouts` is an HTTP endpoint guarded by `CRON_SECRET`. Point any
scheduler at it — Supabase `pg_cron` with `pg_net`, a GitHub Action on a schedule, or
cron-job.org. Daily is plenty:

```bash
curl -X POST https://<your-domain>/api/release-payouts -H "Authorization: Bearer $CRON_SECRET"
```

Until something calls it on a schedule, sellers never get paid — wire this up before
your first real sale, not after.

### Tests

```bash
./scripts/test.sh
```

Runs both suites plus a syntax check over every JS file, including the landing page's
inline script. No Supabase or Stripe account needed. Individually:

```bash
node functions/_shared/stripe.test.mjs
```

Covers webhook signature verification (valid, tampered body, wrong secret, replayed
timestamp, missing header, secret rotation) and Stripe's nested form encoding. Worth
keeping green — a broken verifier means anyone who finds the URL can forge a completed
purchase and unlock every repo.

```bash
node functions/api/check-demo.test.mjs
```

```bash
node functions/api/import-repo.test.mjs
```

20 cases on GitHub URL parsing — the gate deciding which host the server will fetch
on a caller's behalf. Covers the forms people actually paste (`.git` suffixes, deep
tree links, no protocol) and the ones that must be refused (other hosts, lookalike
domains like `github.com.evil.tld`, `file://`, loopback).

35 cases on the SSRF host filter. `/api/check-demo` makes the server fetch a URL the
caller chose, so the filter is the only thing stopping a signed-in seller from using
the worker to probe cloud metadata endpoints or private ranges. Includes the boundary
cases that are easy to get wrong (`172.15.*` and `172.32.*` are public, `172.16–31.*`
are not; a host named `internal-tools.example.com` is fine, `db.internal` is not).

The anon key is public by design and the RLS policy only grants `insert`, so nobody
can read the list back through it. The `service_role` key must never appear in any
file in this directory.

To read local-mode signups collected before that switch, run `forkableWaitlist()` in
the browser console.

## Deploying

Cloudflare Pages, no build command, output directory `/`. `wrangler` isn't installed
on this machine yet — either `npm i -g wrangler` or drag the folder into the Pages
dashboard.

---

## Decisions and open items

**Demo isolation.** The listing iframe needs `allow-same-origin`; without it the demo
apps get an opaque origin, their `localStorage` calls throw, and the app renders blank
(this actually happened during the build). That is safe for cross-origin
seller-hosted demos, which keep their own origin and can't touch the parent page. It
is *not* safe for a same-origin third-party demo. The first-party demos in `demos/`
are our own code, so this is fine today — but **before accepting seller-submitted
demos, move demos to their own origin** (e.g. `demos.<domain>`) so the boundary is
enforced by the browser rather than by review. Cheap now, painful later.

**Stripe Connect prerequisites — the remaining blocker.** The code is written and
tested, but a Connect *platform* needs a real business entity, a completed platform
profile, and acceptance of the Connect ToS. That's account setup only you can do, and
it's the long pole. Nothing charges until it's done.

**Platform fee** defaults to 1500 bps (15%) in `platform_settings`. It lives in the
database rather than an env var so changing it is an audited update rather than a
redeploy — and historical purchases keep the `platform_fee_cents` they were actually
charged, so old rows don't silently re-price when you change the rate.

**Currency is hardcoded to USD** in `checkout.js` and `release-payouts.js`. Fine for
now; revisit when a seller outside the US wants to list.

**Refunds are buyer-favourable on purpose** — self-service, no seller approval, per the
brief. If someone starts refunding every purchase after cloning the repo, the fix is a
per-buyer limit, not a dispute queue. Watch for it before building for it.

**Postgres views bypass RLS unless you say otherwise.** A view runs with its owner's
privileges by default, so `listings_with_seller` — the view browse and the listing page
read — was returning draft and delisted listings to anyone. Every view now sets
`security_invoker = on`, and `preflight.mjs` checks for the regression specifically.
This shipped broken in step 2 and was caught in step 5; local-mode testing hid it,
because the local backend enforced the rule correctly on its own.

**repo_url is protected by column privileges, not just RLS.** RLS is row-level, so a
select policy alone would hand `repo_url` to anyone who can see the row — which is
everyone, since live listings are public. `schema.sql` revokes the column from `anon`
and `authenticated` and routes buyers through the security-definer function
`listing_repo_url()`, which returns it only to the seller or a completed buyer. Verified
in local mode: a signed-out visitor and a second signed-in user both get nothing.

**`stripe_connect_id` is already revoked from client writes** even though Connect isn't
built, so the hole never exists in the first place.

**Purchases have no insert policy on purpose.** Rows get written by the Stripe webhook
with the `service_role` key in step 3. A browser must never be able to mint a purchase.

**SquadCal** was considered as a fourth listing but is a Vite app that needs a build
step to demo, unlike the three single-file tools. Skipped for now rather than shipping
a listing whose demo doesn't run — the whole pitch is that every demo works.

## Deliberately not built

**Phase 2 fork-and-deploy** (a `deploy.config.json` manifest and a guided setup wizard)
and **Phase 2/3 sandbox automation**. The brief is explicit that these wait until real
listings and real sales exist, and that's the right call: the manifest format should be
designed against what actual sellers put in their setup docs, not guessed at now. Phase
1 — seller-supplied demo URL and setup markdown, buyer gets repo access on purchase —
is what's built, and it already beats "here's a zip file".

**Admin moderation UI.** Per the brief, flipping `pending_review` → `live` by hand in
the Supabase dashboard is fine until there's volume worth automating.

## Next step

Everything left is account setup — see [SETUP.md](SETUP.md):

1. Create the Supabase project, run the four SQL files.
2. Do the Stripe Connect platform setup.
3. Deploy to Pages, set the env vars, register the webhook.
4. Schedule both crons — payouts and demo health.
5. List your own three tools for real and get a stranger through checkout.

Then the only question worth answering: does a working demo plus a real refund window
actually change what buyers do, versus a PromptBase-style listing? That's what the
whole thing was built to test.
