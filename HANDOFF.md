# Forkable — handoff for a fresh session

Paste this whole file as your first message to a new cloud session. Written 2026-08-17
from the Mac at `~/marketplace`, verified against the actual repo (not from memory).

---

## What Forkable is

A marketplace where solo builders sell **working operational tools** to other builders.
Not templates, not courses — running software with an ops job.

Three things ARE the product, not features on it:

1. **Live sandbox demo on every listing** — you use the tool before you pay.
2. **Fork-and-deploy packaging** — you get something you can run, not a zip.
3. **Outcome guarantee** — self-service refund for 14 days, and the seller's payout is
   *held* until that window closes. The hold is what makes the promise real.

The whole project exists to answer one question: **does letting someone use the tool
before they pay, plus a refund button they control, change whether they buy?** That is
answered by strangers, not by more features.

Seeded with three of Rigel's own real tools as genuinely working iframed demos:
Guard Scheduler ($149), Lead Scout ($99), RECONSOLE ($129). Platform fee 15%
(`platform_fee_bps = 1500`), stored per-purchase in the DB so old purchases keep the
fee they were charged.

## Where the code is

`~/marketplace` on Rigel's Mac. As of 2026-08-17 that was the **only** copy — no git
remote, no GitHub auth on the machine, 17 commits in one directory. An older line in
`ROADMAP.md` claimed the repo "lives on GitHub"; that was never true, and it's corrected
now. `PUSH-TO-GITHUB.md` is the one-command fix (plus a `gh auth login` only Rigel can
do), and it includes the secret audit that says the push is safe.

If you are a cloud session reading this, the push has presumably happened — sanity-check
with `git remote -v && git log --oneline -1`. Expected HEAD is the "Add HANDOFF.md"
commit on `main`. If you have no code at all, say so plainly; Rigel has to push it.

## Read these, in this order

| File | What it's for |
| --- | --- |
| `ROADMAP.md` | **Canonical status.** What's done, what's next, what's blocking, decisions already settled |
| `CLAUDE.md` | The rules for working in the repo (constraints, security rules, secrets) |
| `START-HERE.md` | Click-by-click for the next few hours of account setup |
| `SETUP.md` | Longer per-system reference (Supabase, Stripe, Cloudflare) |
| `README.md` | How the code works and why |

This handoff exists to give you the parts that are **not** in those files, and to flag
where they've drifted. Where they disagree with each other, the code wins — verify.

## Stack (fixed by the brief — not an open question)

Cloudflare Pages + Pages Functions · Supabase (Postgres/RLS/GoTrue auth) · Stripe
Connect Express. Vanilla JS, hash routing, **no build step, no dependencies, no
framework**. Stripe is called over plain `fetch` rather than its SDK specifically to
keep it that way. **If a change seems to need npm, that is a signal the change is
wrong.**

~6,100 lines. `app/app.js` (1844) is the UI, `app/db.js` (1094) is the data layer,
`functions/api/*` are the server routes, `supabase/*.sql` is the schema.

**The one architectural idea to understand:** `app/db.js` is a single interface over
**two backends** — real Supabase over PostgREST/GoTrue, or a localStorage backend that
mirrors the same RLS rules. Everything is testable with zero accounts. This is also how
two real security bugs got shipped (see Scars).

## Verified state as of 2026-08-17

I ran both of these on the Mac just now:

```bash
./scripts/test.sh
```
**All checks passed** (42 checks, no accounts/network/config needed). Run this before
claiming anything works.

```bash
node scripts/preflight.mjs
```
**3 passed, 6 warnings, 0 failed** — "Not configured yet." Specifically:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`
  are all still placeholders in `.dev.vars`
- `CRON_SECRET` is set but **too short** — needs 32+ random chars, or anyone who
  guesses it can trigger payouts early
- `demoOrigin` is blank (expected until Stage 3)

`config.js` is still `supabaseUrl: ''`, `supabaseAnonKey: ''` → the app is in **local
mode**, blue banner showing. **Nothing has been deployed. No accounts exist yet.**

## The honest status

The **software is finished and tested**; nothing is half-built. What's missing is not
code — it's a Supabase project, a Stripe account, and a deploy, all of which need
accounts only Rigel can create. Six days have passed (last commit 2026-08-16) with no
setup progress, so treat "still not live" as the live fact, not as a stale note.

**Stage 1 — get it on the internet (not started, doesn't need Stripe):**
- [ ] Stripe Connect platform profile submitted — do FIRST then walk away; review takes days
- [ ] Supabase project, all **6** SQL files run **in order**: `waitlist.sql`,
      `schema.sql`, `payments.sql`, `reviews_and_health.sql` (NOT optional — this one
      fixes the views that bypassed RLS), `changelog.sql`, `licenses_and_requests.sql`
- [ ] URL + anon key into `config.js` → local-mode banner disappears
- [ ] `npx wrangler pages deploy .` → public URL
- [ ] Waitlist tested from a phone, row confirmed in Supabase

**Critical sequencing insight, easy to lose:** the landing page makes **zero** `/api/`
calls — the waitlist posts straight to Supabase REST with the anon key, and the demos
are static files. So the site can be publicly live and collecting real signups **while
Stripe is still in review.** Routes with unset env vars return 503 "This part of the
site isn't switched on yet" via `failSetup()` in `functions/_shared/http.js`, which is
safe to show strangers. Don't let the site sit on localhost waiting for Stripe.

**Stage 2 — make money work:** blocked on Stripe review. Then fill 7 vars in
`.dev.vars`, test locally with `4242 4242 4242 4242`, set the same vars in the Pages
dashboard and **redeploy** (vars don't apply retroactively to existing deploys),
register the webhook, then go live.

⚠️ **Schedule TWO crons.** Pages has no cron trigger, so both need an external caller
with the same `CRON_SECRET`: `/api/release-payouts` (without it **sellers are never
paid and nothing errors** — it just silently never happens) and `/api/check-demos`
(without it broken demos rot and the whole pitch dies quietly).

**Stage 3 — let others sell:** hard gate. Remaining step is deployment, not code —
serve `demos/` as a **second Pages project** and set `demoOrigin` in `config.js`. That
retires the first-party same-origin exception by making our own demos cross-origin like
everyone else's. **Do it before accepting any third-party demo.**

**Stage 4 — deliberately not built until real sales:** fork-and-deploy manifest +
wizard, sandbox automation, admin moderation UI, multi-currency, per-buyer refund
limits. Don't build these. Read the request board first.

## Open risk Rigel must decide (do not decide it for him)

`/api/import-repo` (draft-a-listing from a GitHub repo, Claude Opus 5) has **no rate
limit**. It requires a signed-in user, but signup is free and open, so one account can
loop it and spend real money on the Anthropic key. **Rigel has had an API key drained
overnight before.** Cheapest safe default: leave `ANTHROPIC_API_KEY` unset — that
disables exactly one button and nothing else. Otherwise: hard spend cap in the Anthropic
console *before* setting it, or a per-user daily cap in the DB first. Don't set it and
rely on noticing.

Also: stay on Stripe `sk_test_` until the whole loop works; spend alert before `sk_live_`.

## Secrets rules

Nothing secret is in this repo and nothing secret has ever been committed.
`.dev.vars` is gitignored, local-only — never commit it, never paste its contents into a
file, issue, or commit message. `config.js` is served to browsers, so **only the anon
key** may go in it; `service_role` bypasses every policy in the database and lives only
in server env vars.

## Scars — five bugs already shipped here, don't reintroduce them

1. **Postgres views bypass RLS by default.** A view runs with its *owner's* privileges
   unless created `with (security_invoker = on)`. `listings_with_seller` served draft and
   delisted listings to anonymous visitors. Every view now sets it; preflight checks by
   name.
2. **Local-mode parity hid it.** The localStorage backend enforced the rule correctly in
   JS, so tests passed while production would have leaked. Parity between a mock and a
   real backend proves the *mock* is right — it proves nothing about the database. When
   the guarantee is a database guarantee, it is UNVERIFIED until tested against the
   database.
3. **Escaping is not validation.** `esc()` was the only treatment on `demo_url` /
   `repo_url`, and it passes `javascript:` through completely intact — confirmed in a
   real browser. Now **every seller-supplied string that becomes a URL goes through
   `window.FKUrl`** in `app/db.js` (`safeUrl` / `safeHref` / `demoFrame`); only
   http/https ever becomes a link or a frame src. `app/url-safety.test.mjs` guards it
   (44 assertions).
4. **iframe origin.** Demos need `allow-same-origin` or their `localStorage` throws and
   they render blank. Cross-origin demos were always fine — the browser enforces the
   boundary. The hole was a *same-origin* demo holding that flag and reaching into the
   parent page. Now granted only to cross-origin demos and first-party files under
   `demos/` (traversal like `demos/../app.html` normalises and is caught).
5. **RLS is row-level; hiding a column needs `revoke select (col)`.** `profiles` is
   `select using (true)`, and `stripe_connect_id` + the three `stripe_*_enabled` flags
   had `revoke update` but never `revoke select` — so anon could read the entire seller
   roster's Connect IDs straight off `/rest/v1/profiles`. The `seller_public` view was a
   fig leaf over a readable table.

Related: **client-side validation is not a security boundary.** The listing form runs in
the browser; a hostile seller calls the API directly — which is exactly how the test
listing for bug 3 was created. The render side and the database are what have to hold.

**Gotcha:** don't "re-run `schema.sql`" to fix column privileges. Later SQL files
reshape `listings_with_seller`, and `CREATE OR REPLACE VIEW` can't reorder columns, so
it aborts partway. `preflight.mjs` prints the exact one-line `revoke` instead.

## Decisions already made — don't relitigate

| Decision | Why |
| --- | --- |
| Cloudflare Pages + Supabase + Stripe Connect | Fixed by the brief |
| Stripe over plain `fetch`, no SDK | Keeps the project build-step-free |
| Platform fee 15%, stored in the DB | Changing it is an audited update, not a redeploy |
| Refunds buyer-favourable and self-service | It's the entire guarantee. **Never add a seller approval step** |
| Payout held until the refund window closes | Same reason — the hold is what makes the promise real |
| SquadCal not listed as a 4th demo | Needs a build step, so its demo wouldn't run. Every demo must work |

## What a session cannot do

Create Supabase or Stripe accounts, deploy to Cloudflare, or exercise a real payment.
Those are Rigel's. **If a task depends on one, say so plainly rather than mocking around
it** — mocking around a database guarantee is exactly scar #2.

## Who you're working with

Rigel, 18, solo, working toward income from these builds. Input is often voice-to-text,
so expect transcription noise and odd spellings — read for intent. He runs many parallel
projects; Forkable is one. Prefers plain language over jargon and being told the one
next action, not a menu of options.
