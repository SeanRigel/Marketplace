# Forkable — where we stand

Last updated 2026-08-16.

This is the map. When you're lost, start here.

---

## Which file do I open?

| File | What it's for |
| --- | --- |
| **ROADMAP.md** ← you are here | The whole picture. What's done, what's next, what's blocking |
| **START-HERE.md** | Click-by-click for the next few hours. Follow it literally |
| **SETUP.md** | Longer reference, grouped by system. For when START-HERE isn't enough detail |
| **README.md** | How the code works and why it's built that way |

---

## The one-paragraph status

The software is **finished and tested** — 5,200 lines, 42 checks passing, every
feature verified in a browser. Nothing is half-built. What's missing is not code: it's
a Supabase project, a Stripe account, and a deploy, all of which need accounts only
you can create. The site could be publicly live today; only *payments* wait on Stripe's
review queue.

**Right now:** the repo is on GitHub and Supabase is live. Remaining Stage 1 work is
the Cloudflare deploy.

✅ **Pushed to GitHub 2026-08-21** — `github.com/SeanRigel/Marketplace`, 17 commits on
`main`. The Mac is no longer the only copy. Secret audit confirmed clean: `.dev.vars`
was never committed and no live key is tracked. The repo is **public**.

✅ **Supabase project created and schema installed 2026-08-21** — project `Forkable`
(`wtqwuvdeurvwpypejpfp`), region `us-west-1`, free tier. The first six SQL files were
applied in order. `config.js` now carries the project URL and anon key, so the app is out of local
mode and the blue banner is gone.

Verified against the real database, not the localStorage mock:
- All 9 views report `security_invoker = on`
- RLS enabled on all 10 tables
- `anon` is denied `profiles.stripe_connect_id`, the three `stripe_*_enabled` flags,
  and `listings.repo_url`; still reads `display_name`, `title`, `price_cents`,
  `extended_price_cents` and the `listings_with_seller` view
- The signup trigger creates a profile row with `display_name` and `role` parsed from
  user metadata (tested by inserting a real `auth.users` row, then deleted)

⚠️ **Not yet exercised:** the HTTP round-trip through PostgREST. The cloud container's
network policy blocks `*.supabase.co`, so the waitlist POST was never made over the
wire from here. The privileges above were proven at the database level, which is what
PostgREST enforces — but the first real signup from a phone is still the confirming
test, and it stays on the Stage 1 checklist.

---

## Stage 0 — Done ✅

All of this is built, tested, and verified in a browser.

**Foundation**
- [x] Landing page with the full pitch, comparison table, waitlist form
- [x] Three real working demos (Guard Scheduler, Lead Scout, RECONSOLE) served from `demos/`
- [x] App shell, hash routing, no build step, no dependencies
- [x] Dual backend: real Supabase *or* localStorage, one interface — testable with zero accounts

**Marketplace core**
- [x] Auth, profiles, listing create/edit/delete
- [x] Browse, search, sort, category filter
- [x] Reviews and ratings, public seller profiles
- [x] Listing changelogs + a "still maintained?" signal
- [x] Listing completeness meter
- [x] ⌘K command palette
- [x] JSON + RSS feeds

**Money** (code written and unit-tested; unexercised until Stripe clears)
- [x] Stripe Connect Express onboarding for sellers
- [x] Checkout — price read from the database, never the request body
- [x] Two license tiers: single-client and unlimited-client
- [x] Payout hold until the 14-day refund window closes
- [x] Self-service refunds, no seller approval needed
- [x] Webhook handling for checkout / refund / account updates

**Trust and safety**
- [x] RLS on every table
- [x] `security_invoker = on` on every view *(this was a real bug that leaked draft listings — see below)*
- [x] `repo_url` protected by column privileges, not just RLS
- [x] `stripe_connect_id` + onboarding flags likewise *(fixed 2026-08-11)*
- [x] Purchases have no client insert policy — only the webhook can mint one
- [x] Automated demo health checking
- [x] `preflight.mjs` checks for the security regressions specifically

**Extras**
- [x] Request board — buyers post what they'd pay for
- [x] Draft-a-listing from a GitHub repo (optional, needs an Anthropic key)
- [x] Setup errors return a plain sentence, never a variable name *(added 2026-08-11)*
- [x] Seller-supplied URLs validated by scheme; iframes granted same-origin access
      only when it's safe *(added 2026-08-11, 44 assertions)*

---

## Stage 1 — Get it on the internet 🔜 THIS WEEK

**Goal: a public URL collecting real signups. Does not need Stripe.**

Follow `START-HERE.md` Phases 1–3. Roughly 70 minutes of clicking.

- [ ] Stripe Connect profile submitted — *do this first, then walk away; review takes days*
- [x] ~~Supabase project created, first 6 SQL files run in order~~ — done 2026-08-21, verified
- [ ] **`supabase/import_quota.sql` — written but NOT yet applied.** Run it in the SQL
      editor before setting `ANTHROPIC_API_KEY`. Unverified against a database
- [x] ~~`config.js` filled in → blue "Local mode" banner disappears~~ — done 2026-08-21
- [ ] `npx wrangler pages deploy .` → **you have a public URL**
- [ ] Waitlist form tested from your phone, row confirmed in Supabase

The two remaining boxes both need a Cloudflare account, so they are yours. Everything
above them is done.

✅ **Stage 1 is done when** a stranger can open the URL, click into a working demo, and
leave you their email.

> The landing page makes **zero** `/api/` calls — the waitlist talks straight to
> Supabase and the demos are static files. That's why this stage doesn't wait on
> Stripe. Don't let the site sit on localhost.

---

## Stage 2 — Make money work 💳

**Goal: you can buy and refund on the real URL.**

Blocked on Stripe approving your platform profile. Then `START-HERE.md` Phases 4–6.

- [ ] `.dev.vars` filled, `preflight.mjs` says Ready
- [ ] Full local test: two accounts, buy with `4242 4242 4242 4242`, refund
- [ ] 7 env vars set in the Cloudflare dashboard, redeployed *(vars don't apply retroactively)*
- [ ] Stripe webhook registered against the live URL
- [ ] **Both crons scheduled** — `/api/release-payouts` and `/api/check-demos`
- [ ] Switch to `sk_live_`, spend alert set, one real few-dollar purchase and refund
- [ ] **Decide on `ANTHROPIC_API_KEY`** — see the warning below before you set it

⚠️ **The payout cron is the one that silently ruins you.** Without it, sellers are
never paid, and nothing errors — it just never happens.

⚠️ **`/api/import-repo` has no rate limit.** It requires a signed-in user, but signup
is open and free, so one person can make an account and call it in a loop — every call
spends money on your Anthropic key. You have had a key drained overnight before. Three
options, cheapest first: leave `ANTHROPIC_API_KEY` unset (the feature is optional and
everything else works without it); set a hard spend cap in the Anthropic console before
you set it; or add a per-user daily cap in the database first. Don't set the key and
rely on noticing.

✅ **Stage 2 is done when** you've moved real money out and back.

---

## Stage 3 — Let other people sell 🔒 HARD GATE

**This is the stage that turns it from your storefront into a marketplace, and it has
a security prerequisite that is easy to miss.**

- [x] **Treat seller URLs as hostile** — scheme validation + iframe origin rules *(done 2026-08-11)*
- [ ] **Serve demos from their own origin** — deploy `demos/` as a second Pages project,
      then set `demoOrigin` in `config.js`. Preflight warns until you do
- [ ] Decide how a listing gets from `pending_review` → `live` (by hand in Supabase is fine at first)
- [ ] Write the seller agreement / terms — what you'll delist, who owns what
- [ ] Onboard 2–3 sellers you actually know before opening it up

**What was wrong, and what's now handled.** Two separate holes, easy to conflate:

*Scheme.* `esc()` makes a string safe to sit inside HTML but not to *be* an href —
`javascript:` passed through it completely intact. A seller could put
`javascript:...` in `demo_url` or `repo_url`, and a buyer clicking "Open in a new tab"
would run that code in the page, next to the session token. Verified in a real browser:
the escaped string kept its `javascript:` protocol. Now every URL goes through
`FKUrl.safeUrl()` and only http/https ever becomes a link or a frame src.

*Origin.* The listing iframe needs `allow-same-origin` or demo apps render blank —
their `localStorage` throws. Cross-origin demos were always fine; the browser enforces
the boundary. The hole was a *same-origin* demo holding that flag, which can reach into
the parent page. Now `allow-same-origin` is granted only to cross-origin demos and to
first-party files under `demos/` — anything else same-origin is refused an embed.

That closes the code-level hole, but the first-party exception still exists. Setting
`demoOrigin` retires it entirely by making our own demos cross-origin like everyone
else's. **Do that before you accept a third-party demo.**

✅ **Stage 3 is done when** someone who isn't you has a live listing and you didn't
have to trust their code.

---

## Stage 4 — Only after real sales 📈

Deliberately not built. The brief is explicit and it's the right call — these should be
designed against what real sellers actually do, not guessed at now.

- [ ] **Fork-and-deploy**: `deploy.config.json` manifest + guided setup wizard
- [ ] **Sandbox automation**: spin up per-buyer demo instances instead of shared ones
- [ ] **Admin moderation UI**: only when hand-flipping rows gets annoying
- [ ] Multi-currency — hardcoded USD today; revisit when a non-US seller shows up
- [ ] Per-buyer refund limits — only if someone actually abuses self-service refunds

**Read the request board before picking from this list.** People stating what they'd
pay for is the best research you'll get.

---

## Decisions already made — don't relitigate

| Decision | Why |
| --- | --- |
| Cloudflare Pages + Supabase + Stripe Connect | Fixed by the brief, never an open question |
| Stripe over plain `fetch`, no SDK | Keeps the project build-step-free |
| Platform fee 15%, stored in the database | Changing it is an audited update, not a redeploy. Old purchases keep the fee they were charged |
| Refunds are buyer-favourable, self-service | It's the entire guarantee. Don't add a seller approval step |
| Payout held until the refund window closes | Same reason. The hold is what makes the promise real |
| SquadCal not listed as a 4th demo | It needs a build step, so its demo wouldn't run. Every demo must work |

---

## Scars worth remembering

**The RSS feed could be taken down by one seller's title.** Found 2026-08-21. The RSS
branch of `/api/feed` escaped `<>&'"` but not control characters. Postgres text happily
stores a vertical tab; XML 1.0 forbids it outright and has no escape for it, so `&#11;`
is not a fix. One listing carrying one such byte makes the **entire feed** unparseable
for every subscriber — a whole-feed outage caused by a single seller's title, with no
error anywhere on our side. Now stripped before escaping; tab, newline and carriage
return are kept because they are legal.

Small, but the shape is worth remembering: escaping is per-format, and "we escaped it"
answers a different question from "is this byte legal in this format at all".


**An SSRF allow-check that only understood dotted-quad, and a `redirect: 'follow'`
that walked around it anyway.** Found 2026-08-21 auditing the two routes that fetch a
seller-supplied URL.

`check-demo.js` vetted the hostname with a dotted-quad regex plus a small deny list.
Nine spellings walked straight through, confirmed by running the real function:

| spelling | resolves to |
| --- | --- |
| `2130706433` | 127.0.0.1 (32-bit decimal) |
| `0x7f000001` | 127.0.0.1 (hex) |
| `0177.0.0.1` | 127.0.0.1 (octal) |
| `127.1` | 127.0.0.1 (inet_aton fills the gap) |
| `::ffff:169.254.169.254` | cloud metadata over IPv4-mapped IPv6 |
| `100.64.0.1`, `192.0.0.1`, `198.18.0.1` | CGNAT / IETF / benchmark ranges |

A hostname does not have to be dotted-quad to resolve. The fix parses inet_aton-style
into a number and tests the number against CIDR ranges.

Worse than the spellings: the fetch used `redirect: 'follow'`. So even a correct
hostname check was decorative — a public URL that 302s to `http://169.254.169.254/`
passed the pre-flight and was followed anyway. Redirects are now resolved by hand with
every hop re-vetted (`safeFetch`).

And `check-demos.js` — the *cron* sweep, which fetches `demo_url` straight off live
listings — had **no host check at all**, only a protocol check. A seller could point
`demo_url` at an internal address and read the result back: `http_status` and
`last_error` land in `sandbox_instances`, which that seller can select through the
listing's RLS policy. A blind SSRF with an oracle attached.

Both routes now share `functions/_shared/net-safety.js`, guarded by 67 assertions in
`net-safety.test.mjs` — every bypass above is a named test case.

Two things worth keeping in mind:

- **The mask bug inside the fix.** The first version of the CIDR check compared
  `(value & mask)` against an unsigned base. `&` yields a *signed* 32-bit int, so every
  range at or above `128.0.0.0` — 169.254/16, 172.16/12, 192.168/16, multicast —
  silently never matched, while 10/8 and 127/8 matched fine. It looked like it worked.
  Caught only because the test file asserted the ranges individually.
- **What this still cannot do.** It checks hostnames, not the addresses they resolve
  to. A public name can point at 127.0.0.1 (`localtest.me` does), and DNS can change
  between the check and the connection. Workers can't resolve-and-pin, so literal
  vetting plus per-hop redirect checks is the ceiling. Anything that must be airtight
  needs a host allow-list.


**A column-level `revoke select` is a silent no-op under a table-level grant.**
Found 2026-08-21 while installing the schema into a real Supabase project for the
first time. `schema.sql` and `payments.sql` both said

```sql
revoke select (stripe_connect_id) on public.profiles from anon, authenticated;
```

which is what scar #5 concluded last time. It runs without error and **changes
nothing**, because Supabase grants `anon`/`authenticated` table-level select on new
tables in `public`, and in Postgres a table grant implies every column — a column
revoke cannot subtract from it. Demonstrated directly: broken state → run the old
one-liner → `has_column_privilege('anon',...,'stripe_connect_id','SELECT')` still
`true`. So on a fresh install every seller's Connect id and every listing's `repo_url`
— the thing being sold — were world-readable over `/rest/v1/`, exactly the leak scar #5
was supposed to have closed.

Worse, `preflight.mjs` *detected* the leak correctly but printed that same one-liner as
the fix, so following its advice produced a clean-looking run and an unchanged leak.

Fixed by revoking the table grant and granting back the public columns, computed from
`information_schema` so it cannot drift. Both the SQL and preflight's remedy text now
do this. Two things this leaves behind:

- `alter table ... add column` does **not** extend a column-level grant. A new public
  column is invisible until granted — which is why `licenses_and_requests.sql` re-runs
  the block after adding `extended_price_cents`.
- The lesson under the lesson: scar #5's *diagnosis* was right and its *remedy* was
  wrong, and nothing caught that for months because the remedy was never run against a
  real database. A fix you have not executed is a hypothesis.


**Postgres views bypass RLS by default.** A view runs with its *owner's* privileges, so
`listings_with_seller` was serving draft and delisted listings to anyone who asked.
Shipped broken, caught three steps later. Every view now sets `security_invoker = on`
and preflight checks for the regression.

**Local-mode parity hid it.** The localStorage backend enforced the rule correctly on
its own, so tests passed while production would have leaked. Convenient mocks can hide
real security bugs — when the check is a *database* guarantee, test it against the
database.

**Escaping is not validation.** `esc()` was applied to seller URLs everywhere and it
looked like the job was done. It wasn't: escaping decides whether a string is safe
*inside* HTML, and says nothing about whether it's safe *as* a URL. Two different
questions, one function, three years of that mistake in other people's codebases.

**The form gate is not the security boundary.** Listing validation runs in the browser,
so a hostile seller just calls the API directly — which is exactly how the test listing
for this was created. Client-side checks are there to help honest people; the render
side is what actually has to hold.

**A curated view doesn't protect the table underneath it.** `seller_public` was written
to expose "no email, no Stripe state" — but `profiles` has `select using (true)` and no
column-level revoke, so anyone could read `stripe_connect_id` and the onboarding flags
straight off `/rest/v1/profiles`. RLS is row-level; hiding a *column* needs
`revoke select (col)`. The same reasoning had already been applied to `repo_url` on
listings and simply wasn't carried across. Fixed 2026-08-11, with preflight checks so
it can't come back.

---

## Check status yourself

From the repo root — `~/marketplace` on the Mac, wherever it's checked out in a cloud
session:

```bash
./scripts/test.sh
```

```bash
node scripts/preflight.mjs
```

`test.sh` needs no accounts and should always pass. `preflight.mjs` tells you in plain
English what's still unconfigured, and refuses to pass until it's genuinely right.

---

## The only question that matters

Everything here is built to answer one thing:

> **Does letting someone use the tool before they pay, plus a refund button they
> control, actually change whether they buy?**

You cannot answer that with more features. Only with strangers. Stage 1 is what gets
you strangers — which is why it doesn't wait for Stripe.
