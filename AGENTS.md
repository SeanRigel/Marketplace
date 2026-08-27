# For any AI agent working on Forkable

Vendor-neutral entry point. `CLAUDE.md` is loaded automatically by Claude Code;
`AGENTS.md` is the convention most other tools look for. **The two must say the same
thing** — if you change one, change the other, and if they disagree, the code wins.

Works the same whether you are Claude, Grok, GPT, Gemini, Cursor, or a human.

---

## Handing this project to a new agent — checklist for Rigel

Whoever is setting this up, do these in order. The order matters more than it looks.

1. **Push everything first.** An agent that clones `main` while work is still sitting in
   a patch gets a version of the project that is missing whole features, and will
   cheerfully rebuild things that already exist or contradict decisions already made.
   This is the only step that can genuinely waste someone's day.
2. **Clone the repo** and open it in whatever tool the agent runs in.
3. **Paste this file as the first message.** Then `HANDOFF.md`, which is longer and
   fills in the history.
4. **Tell it what it cannot do in that environment.** If it has no Supabase connector it
   can write SQL but cannot run it — which is scar #6 exactly, the bug that survived
   months because a prescribed fix was never executed. Any SQL it hands over is a
   hypothesis until someone runs it.
5. **Expect patches, not pushes.** Assume read-only GitHub access until proven otherwise.

None of the project's state lives in a chat log, deliberately. It is all in this repo —
which is why steps 2 and 3 are enough, provided step 1 actually happened.

---

## Start here, in this order

1. **Paste `HANDOFF.md` as your first message.** It was written for exactly this: a
   cold session with no memory of the project. Everything else assumes you have read it.
2. `ROADMAP.md` — where things stand, what is next, and **"Scars worth remembering"**,
   which is eight bugs that already shipped here. Read that section before writing any
   security-adjacent code. Every one of them looked correct at the time.
3. `CLAUDE.md` — the working rules. Constraints, security rules, how secrets are handled.
4. `ONBOARDING.md` — written for human contributors, but the access rules and the
   "what is already decided" list apply to you identically.
5. `README.md` — how the code works and why it is built this way.

`docs/` holds three standalone pages: the security audit, the launch plan through 500
users, and the deploy walkthrough. Open them in a browser rather than reading the HTML.

---

## The five things that will trip you up

**1. No build step. No dependencies. No framework.** Vanilla JS, hash routing, files
served as-is. Stripe and Resend are both called over plain `fetch` rather than their
SDKs specifically to keep it that way. **If a change seems to need npm, the change is
wrong.** Say so rather than adding a bundler.

**2. Local mode can hide database bugs.** `app/db.js` is one interface over two
backends: real Supabase, or a localStorage backend that re-implements the same rules in
JavaScript. That makes everything testable with zero accounts — and it is exactly how
two real security bugs passed tests while production would have leaked. **When the
guarantee is a database guarantee, it is not proven until it runs against the database.**

**3. A fix you have not executed is a hypothesis.** Scar #6 is the one to internalise:
the previous security pass diagnosed a column leak correctly and prescribed a remedy
that is a *silent no-op*. It ran clean, reported success, changed nothing, and nobody
noticed for months — because the remedy was never run against a real database.

**4. And the converse.** A test that does not reproduce the real call pattern can
condemn working code as easily as it can bless broken code. The spend cap was nearly
"fixed" on the strength of a test that made seven calls inside one SQL statement, where
all seven read the same snapshot. Seven HTTP requests behave nothing like that.

**5. Escaping is not validation, and it is per-format.** Every seller-supplied string
that becomes a URL goes through `window.FKUrl` — `esc()` passes `javascript:` through
untouched. And "we escaped it" answers a different question from "is this byte legal in
this format at all" (scar #8, a control character that made the whole RSS feed
unparseable).

---

## Before you claim anything works

```bash
./scripts/test.sh
```

262 assertions. No accounts, no network, no config. Should always pass. Run it before
saying a change is done, not just when it feels risky. Needs Node.

```bash
node scripts/preflight.mjs
```

Checks real configuration and exits non-zero until it is genuinely right. Needs a
`.dev.vars`, so it will not do much in a fresh environment. That is expected, not a
failure.

---

## Where the state actually lives

Nothing important is in a chat log. This is deliberate — sessions end, and the project
has already survived several handovers.

| Thing | Where |
| --- | --- |
| Code | `github.com/SeanRigel/Marketplace`, branch `main` |
| Status, scars, decisions | `ROADMAP.md` |
| Database | Supabase project `Forkable` (`wtqwuvdeurvwpypejpfp`, us-west-1) |
| Schema | `supabase/*.sql`, applied in filename order as listed in `START-HERE.md` |
| What is done vs unproven | `ROADMAP.md`, and the ledger in `docs/session-2026-08-21.html` |

**Check the repo before believing any summary, including this file.** Several documents
here have been confidently wrong before — `ROADMAP.md` claimed for weeks that the code
"lives on GitHub" when it had never been pushed anywhere.

---

## What a cloud session can and cannot do

Verify this rather than assuming; it has changed twice already.

**Usually can:** read and write files, run the test suite, and — when a Supabase
connector is attached — apply migrations and run SQL against the real database. That
last one is the only way to prove a database guarantee, so use it rather than reasoning
about what Postgres would probably do.

**Usually cannot:** push to GitHub (the Claude GitHub App is read-only on this repo —
`git push` and the API both return 403), deploy to Cloudflare, create a Stripe account,
or reach `*.supabase.co` over plain HTTP.

Work therefore reaches Rigel as a patch file:

```bash
git format-patch origin/main..HEAD --stdout > work.patch
git apply --check work.patch      # verify against origin/main before sending
```

He applies it with `git am` and pushes. **Do not report work as pushed.**

---

## Do not relitigate these

Full list with reasoning is in `ROADMAP.md`. The short version:

| Decision | Why |
| --- | --- |
| Cloudflare Pages + Supabase + Stripe Connect | Fixed by the brief |
| Plain `fetch` over vendor SDKs | Keeps the project build-step-free |
| Platform fee 15%, stored per-purchase in the database | Changing it is an audited update, not a redeploy |
| Refunds buyer-favourable and self-service | It is the entire guarantee. **Never add a seller approval step** |
| Payout held until the refund window closes | Same reason — the hold is what makes the promise real |

## Do not build these yet

`ROADMAP.md` Stage 4: the fork-and-deploy manifest and wizard, sandbox automation, a
polished admin UI, multi-currency, per-buyer refund limits.

They are not missing by accident. The project is trying to find out whether anyone buys,
and every week spent there is a week not spent finding that out. **Read the request board
first.**

---

## Who you are working with

Rigel, 18, solo, working toward income from these builds. Voice-to-text is common, so
expect transcription noise — read for intent. Prefers plain language over jargon, and
being told the one next action rather than a menu of options.

He is new to git and deployment. "Run this in the terminal" is not a sufficient
instruction — say which app, what to expect, and what a failure looks like. Two real
examples already hit: browsers strip hyphens from downloaded patch filenames, and git
asking for a "password" actually wants an access token.

If a task depends on an account only he has, **say so plainly rather than mocking your
way around it.** Mocking around a database guarantee is scar #2, and shipping an
unexecuted fix is scar #6.
