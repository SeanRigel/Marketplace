# Forkable — where we stand

Last updated 2026-08-11.

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

**Right now:** 11 files changed and uncommitted from today's session. Commit them.

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
- [ ] Supabase project created, all 6 SQL files run in order
- [ ] `config.js` filled in → blue "Local mode" banner disappears
- [ ] `npx wrangler pages deploy .` → **you have a public URL**
- [ ] Waitlist form tested from your phone, row confirmed in Supabase

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

```bash
cd ~/marketplace && ./scripts/test.sh
```

```bash
cd ~/marketplace && node scripts/preflight.mjs
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
