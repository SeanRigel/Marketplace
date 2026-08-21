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

`github.com/SeanRigel/Marketplace`, branch `main` — **pushed 2026-08-21**, and also at
`~/marketplace` on Rigel's Mac. The Mac is no longer the only copy. The repo is
**public**; the secret audit in `PUSH-TO-GITHUB.md` confirmed that is safe (`.dev.vars`
was never committed, no live key is tracked).

Sanity-check on arrival: `git log --oneline -1`. If the tree is empty, say so plainly
rather than reconstructing it from this file — a rebuilt copy that merely resembles the
real one is worse than none.

⚠️ **A cloud session cannot push.** The GitHub App attached to these sessions is
read-only on this repo: `git push` and the API both return 403. Work still gets
committed locally, but it reaches Rigel as a patch file
(`git format-patch origin/main..HEAD --stdout`) which he applies with `git am`. Verify
it first with `git apply --check` against `origin/main`. Do not report work as pushed.

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
**All checks passed** — 203 assertions, no accounts/network/config needed. Run this
before claiming anything works.

```bash
node scripts/preflight.mjs
```
Needs a real `.dev.vars`, which a cloud session does not have. Expect it to report
placeholders and stop before the live checks — that is correct, not a failure.

**Supabase is live.** Project `Forkable` (`wtqwuvdeurvwpypejpfp`, us-west-1, free tier),
created 2026-08-21. `config.js` carries the project URL and anon key, so the app is out
of local mode and the blue banner is gone. Six of the seven SQL files are applied.

**Stripe does not exist yet, and nothing is deployed.** No Cloudflare project, no public
URL, no payment has ever been exercised.

## The honest status

The **software is finished and tested**; nothing is half-built. What is missing is a
Stripe account and a deploy, both of which need accounts only Rigel can create.

**Stage 1 — get it on the internet (doesn't need Stripe):**
- [ ] Stripe Connect platform profile submitted — do FIRST then walk away; review takes
      days. Still not started as of 2026-08-21; this clock has never been running
- [x] ~~Supabase project, SQL files run in order~~ — done 2026-08-21, verified against
      the database. There are now **7** files, and the 7th is not yet applied (below)
- [x] ~~URL + anon key into `config.js`~~ — done 2026-08-21
- [ ] `npx wrangler pages deploy .` → public URL
- [ ] Waitlist tested from a phone, row confirmed in Supabase — **never exercised over
      HTTP.** Cloud sessions are network-blocked from `*.supabase.co`, so the privileges
      were proven at the database level but the round trip through PostgREST was not

**Applied to the database, in this order:** `waitlist.sql`, `schema.sql`, `payments.sql`,
`reviews_and_health.sql` (NOT optional — fixes the views that bypassed RLS),
`changelog.sql`, `licenses_and_requests.sql`.

⚠️ **`import_quota.sql` is written but has NEVER been executed.** It caps spending on
`/api/import-repo`. Run it before `ANTHROPIC_API_KEY` is ever set, then confirm it
actually denies the sixth draft in a day. Until someone watches that happen it is a
hypothesis, not a cap.

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

## Scars — eight bugs already shipped here, don't reintroduce them

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

6. **A column-level `revoke select` is a silent no-op under a table-level grant.**
   Found 2026-08-21, installing the schema into a real project for the first time. The
   remedy scar 5 concluded with — `revoke select (stripe_connect_id) on public.profiles`
   — runs clean and **changes nothing**, because Supabase grants `anon` table-level
   select on new tables and a table grant implies every column. So on a fresh install
   every Connect id and every `repo_url` was world-readable, exactly the leak scar 5 was
   supposed to have closed. Worse, `preflight.mjs` detected it correctly but printed
   that same broken one-liner as the cure. Fix: drop the table grant, grant back the
   public columns computed from `information_schema`. **Scar 5's diagnosis was right and
   its remedy was wrong, and nothing caught that for months because the remedy was never
   run against a database. A fix you have not executed is a hypothesis.**

7. **SSRF: a dotted-quad regex is not an address check, and `redirect: 'follow'` walks
   around whatever check you do have.** Found 2026-08-21. `check-demo.js` let nine
   spellings through (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`,
   `::ffff:169.254.169.254`, CGNAT and reserved ranges). And `check-demos.js` — the cron
   sweep, fetching `demo_url` off live listings — had **no host check at all**, with the
   result readable by the seller via `sandbox_instances`. Both now use
   `functions/_shared/net-safety.js` (67 assertions). Note the bug found *inside* that
   fix: `(value & mask)` yields a **signed** 32-bit int, so every range at or above
   `128.0.0.0` silently never matched while 10/8 and 127/8 matched fine.

8. **Escaping is per-format: "we escaped it" is a different question from "is this byte
   legal here at all".** Found 2026-08-21. The RSS branch of `/api/feed` escaped
   `<>&'"` but not control characters, which XML 1.0 forbids outright and offers no
   escape for. One listing containing one vertical tab makes the **entire feed**
   unparseable for every subscriber, with no error on our side.

Related: **client-side validation is not a security boundary.** The listing form runs in
the browser; a hostile seller calls the API directly — which is exactly how the test
listing for bug 3 was created. The render side and the database are what have to hold.

Related to bug 2: `app/local-rules.test.mjs` now pins the localStorage backend to the
same rules the SQL enforces (30 assertions). They passed first run — the mock had not
drifted — but it can no longer drift silently. It did surface one gap: local mode applied
no CHECK constraints, so it accepted rows Postgres refuses.

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

## What a session can and cannot do

This changed on 2026-08-21 and the old blanket "a session can't touch the database" is
no longer true. Check what is actually connected before assuming either way.

**Can**, when the connector is attached:
- Supabase over MCP — create projects, apply migrations, run SQL, read advisors. The
  entire schema install and every privilege check on 2026-08-21 was done this way. This
  is the one thing that makes a database guarantee *provable* from a session, so use it
  rather than reasoning about what Postgres would probably do.

**Cannot:**
- **Push to GitHub.** Read-only App; `git push` and the API both 403. Deliver a patch.
- Create a Stripe account, or exercise a real payment.
- Deploy to Cloudflare.
- Reach `*.supabase.co` over plain HTTP — the egress policy blocks it, so PostgREST
  round trips cannot be tested from here even while the MCP connector works fine.

Connectors drop mid-session without warning; the Supabase one did on 2026-08-21, which
is why `import_quota.sql` is written but unproven. **If a connector goes and a task
depends on it, say so plainly rather than mocking around it** — mocking around a
database guarantee is exactly scar #2, and shipping an unexecuted fix is scar #6.

## Who you're working with

Rigel, 18, solo, working toward income from these builds. Input is often voice-to-text,
so expect transcription noise and odd spellings — read for intent. He runs many parallel
projects; Forkable is one. Prefers plain language over jargon and being told the one
next action, not a menu of options.
