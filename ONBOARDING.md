# Joining Forkable

For Jack, Luke, or anyone else picking this up. Read this once, top to bottom, before
you touch anything. It should take about ten minutes.

---

## First: what to paste into Claude

This repo is built to be worked on with Claude Code, and it carries its own briefing.
Open a session in the repo and paste **`HANDOFF.md`** as your first message. It is
written for exactly that — it explains the project, where it stands, what is already
decided, and the five bugs that have already been shipped here once.

After that, `CLAUDE.md` loads automatically in any session in this directory. You do not
need to paste it.

The order to read them yourself:

| File | What it's for |
| --- | --- |
| `HANDOFF.md` | The full briefing. Paste this into Claude first |
| `ROADMAP.md` | Where the project stands, what's next, what's settled |
| `CLAUDE.md` | The rules for working in this repo |
| `README.md` | How the code works and why |
| `SETUP.md` | Per-system reference: Supabase, Stripe, Cloudflare |

---

## What Forkable is, in four lines

A marketplace where solo builders sell **working operational tools** to other builders —
running software, not templates or courses. Three things are the product, not features
on it: a **live demo on every listing** so you use it before paying, **fork-and-deploy
packaging** so you get something runnable, and an **outcome guarantee** — self-service
refund for 14 days, with the seller's payout *held* until that window closes.

The whole project exists to answer one question: **does letting someone use the tool
before they pay, plus a refund button they control, change whether they buy?** Strangers
answer that. More features do not.

---

## The three rules that will bite you first

**1. No build step. No dependencies. No framework.** Vanilla JS, hash routing, files
served as-is. Stripe is called over plain `fetch` rather than its SDK specifically to
keep it that way. **If a change seems to need npm, that is a signal the change is
wrong.** Come and say so rather than adding a bundler.

**2. Read "Scars worth remembering" in `ROADMAP.md` before writing any security-adjacent
code.** Eight bugs have already shipped here. They are written up with what went wrong
and why, because every one of them looked correct at the time. The short version:

- Every seller-supplied string that becomes a URL goes through `window.FKUrl`. Escaping
  is not URL validation — `esc()` passes `javascript:` through untouched.
- Every Postgres view needs `security_invoker = on`, or it bypasses RLS silently.
- Hiding a column needs the table grant dropped and the public columns granted back. The
  obvious `revoke select (col)` is a **silent no-op**.
- Client-side validation is not a security boundary. The listing form runs in a browser
  a hostile seller controls.

**3. Local mode can hide all of it.** `app/db.js` is one interface over two backends:
real Supabase, or a localStorage backend that mirrors the same rules in JavaScript. That
makes everything testable with zero accounts — and it is the reason two real security
bugs passed tests while production would have leaked. **When the guarantee is a database
guarantee, it is not proven until it runs against the database.**

---

## Before you say something works

```bash
./scripts/test.sh
```

No accounts, no network, no config needed. 203 assertions. Should always pass. Run it
before saying a change is done, not just when it feels risky. You need Node installed
(nodejs.org, the macOS `.pkg` installer).

```bash
node scripts/preflight.mjs
```

Checks real configuration and exits non-zero until it is genuinely right. It needs a
`.dev.vars`, so it will not do much until you have one.

---

## Secrets — the part that matters now that there is more than one of us

Nothing secret is in this repo and nothing secret has ever been committed. Keep it that
way. More people means more places a key can leak from, so this is stricter than it was.

**Never:**
- Commit `.dev.vars`. It is gitignored. Leave it that way.
- Put any key in `config.js` except the Supabase **anon** key. That file is served to
  browsers.
- Paste a key into Discord, iMessage, a Google Doc, a GitHub issue, or an AI chat.
  Not "just this once" — chat logs are backed up and searchable forever.
- Screenshot a dashboard page with a key visible.

**The two that end the project if they leak:**
- `SUPABASE_SERVICE_ROLE_KEY` — bypasses every access rule in the database. Full read
  and write on everything, including other people's data.
- `STRIPE_SECRET_KEY` — moves money. `sk_test_` is harmless; `sk_live_` is not.

**How to share them:** a password manager with a shared vault (1Password, Bitwarden —
Bitwarden's free tier does this). Not chat. If a key ever does go somewhere it shouldn't,
say so immediately and rotate it — that is a five-minute fix and a non-event. Hiding it
is what turns it into a real problem.

**Prefer per-person access over a shared login.** Supabase, Cloudflare and Stripe all
support inviting people as members with their own accounts and their own permission
level. Use that instead of passing Rigel's password around: it means access can be
revoked for one person without changing anything for everyone else, and the audit log
shows who actually did what.

---

## How work flows

1. Branch off `main`. Never commit straight to it.
2. Make the change. Run `./scripts/test.sh`.
3. Push the branch and open a pull request.
4. Rigel reviews and merges.

```bash
git checkout main
git pull origin main
git checkout -b your-name/what-youre-doing
# ...work...
./scripts/test.sh
git push -u origin your-name/what-youre-doing
```

If you are working with Claude Code and it made the change, the same rules apply — run
the tests, open a PR, do not push to `main`.

---

## What is already decided — please don't reopen these

`ROADMAP.md` has the full list with reasoning. The short version:

| Decision | Why |
| --- | --- |
| Cloudflare Pages + Supabase + Stripe Connect | Fixed by the brief |
| Stripe over plain `fetch`, no SDK | Keeps the project build-step-free |
| Platform fee 15%, stored in the database | Changing it is an audited update, not a redeploy |
| Refunds buyer-favourable and self-service | It is the entire guarantee. **Never add a seller approval step** |
| Payout held until the refund window closes | Same reason — the hold is what makes the promise real |

New ideas are welcome. These specific ones were settled deliberately, and reopening them
costs more than it looks like it does.

---

## What NOT to build yet

`ROADMAP.md` Stage 4 lists things that are deliberately not built until there are real
sales: the fork-and-deploy manifest and wizard, sandbox automation, an admin moderation
UI, multi-currency, per-buyer refund limits.

They are not missing by accident. The project is trying to find out whether anyone buys,
and every week spent on Stage 4 is a week not spent finding that out. **Read the request
board before building anything on that list.**

---

## Where things actually stand

Check `ROADMAP.md` — it is the canonical answer and this section will drift.

As of 2026-08-21: the software is finished and tested. The repo is on GitHub. Supabase is
live with the schema installed and verified. What is missing is a Stripe account still in
review, and a deploy that has not happened yet. Nothing is half-built.

The near-term goal is narrow: **get the site publicly live and collecting real signups.**
The landing page makes zero `/api/` calls — the waitlist talks straight to Supabase and
the demos are static files — so this does not wait on Stripe.

---

## Who to ask

Rigel owns the accounts (GitHub, Supabase, Stripe, Cloudflare) and the product decisions.
Anything that needs a login, a payment, or a call on direction goes to him.

If something in these docs contradicts the code, **the code wins** — and say so, so the
doc gets fixed. Several of them have been wrong before.
