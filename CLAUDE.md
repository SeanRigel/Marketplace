# Working on Forkable

**Open `ROADMAP.md` first.** It is the map: what's done, what's next, what's blocking,
and the decisions that are already settled. This file is only the rules for working in
this repo — it deliberately does not repeat what the other docs say.

| File | What it's for |
| --- | --- |
| `ROADMAP.md` | Where the project stands. Start here |
| `HANDOFF.md` | Cold-start brief for a fresh session — paste it as the first message |
| `PUSH-TO-GITHUB.md` | Getting the repo off this Mac (it has never been pushed) |
| `START-HERE.md` | Click-by-click for the next few hours of setup |
| `SETUP.md` | Per-system reference (Supabase, Stripe, Cloudflare) |
| `README.md` | How the code works and why it's built that way |

---

## Constraints that are not up for debate

**No build step. No dependencies. No framework.** Vanilla JS, hash routing, files
served as-is. Stripe is called over plain `fetch` rather than its SDK specifically to
keep it that way. If a change seems to need npm, that is a signal the change is wrong.

**The stack is fixed:** Cloudflare Pages + Pages Functions, Supabase (Postgres/RLS/
auth), Stripe Connect Express. This was fixed by the brief and is not an open question.

See "Decisions already made — don't relitigate" in `ROADMAP.md` for the rest.

---

## Before you say something works

```bash
./scripts/test.sh
```

Needs no accounts, no network, no config. Should always pass. Run it before claiming a
change is done — not just when it feels risky.

```bash
node scripts/preflight.mjs
```

Checks real configuration and exits non-zero until it is genuinely right. Expected to
fail until the accounts exist; it fails with a plain-English reason, so read it.

---

## Security rules with scars behind them

Each of these is here because it already went wrong once. `ROADMAP.md` §"Scars worth
remembering" has the full story for each.

**Every seller-supplied string that becomes a URL goes through `window.FKUrl`** in
`app/db.js` — `safeUrl` / `safeHref` / `demoFrame`. Never pass `demo_url` or `repo_url`
to an `href` or `src` with only `esc()` on it. Escaping decides whether a string is safe
*inside HTML*; it says nothing about whether it is safe *as a URL*, and it passes
`javascript:` through untouched. `app/url-safety.test.mjs` guards this.

**RLS is row-level. Hiding a column needs `revoke select (col)`.** `profiles` is
`select using (true)`, so any column without an explicit revoke is world-readable over
`/rest/v1/`. A curated view over the table does not protect the table.

**Every Postgres view needs `security_invoker = on`.** Without it a view runs with its
owner's privileges and silently bypasses RLS.

**Client-side validation is not a security boundary.** The listing form runs in the
browser; a hostile seller calls the API directly. The render side and the database are
what actually have to hold.

**Local mode can hide all of the above.** `app/db.js` is one interface over two
backends — real Supabase, or a localStorage backend that mirrors the same rules. That
makes everything testable with zero accounts, and it is the reason the RLS bugs above
passed tests while production would have leaked. When the guarantee is a *database*
guarantee, it is not proven until it runs against the database.

---

## Secrets

Nothing secret belongs in this repo, and nothing secret has ever been committed to it.

- `.dev.vars` is gitignored and holds local values only. Never commit it, never paste
  its contents into a file, an issue, or a commit message.
- `config.js` is served to browsers. Only the Supabase **anon** key may go in it. The
  `service_role` key bypasses every policy in the database and belongs solely in server
  env vars.
- Routes whose env vars are unset return 503 via `failSetup()` in
  `functions/_shared/http.js`, and log the missing variable name rather than showing it.
  A partly-configured deploy is safe to show strangers.

**Open risk, unresolved:** `/api/import-repo` has no rate limit, and signup is free, so
one account can loop it and burn the Anthropic key. Leaving `ANTHROPIC_API_KEY` unset
disables that one button and nothing else. Do not enable it without adding a limit.

---

## Working from a cloud session

A web session starts with no accounts and no `.dev.vars`, and that is fine — the whole
app runs in local mode. `./scripts/test.sh` is the full safety net available to you.

What you cannot do from here: create Supabase or Stripe accounts, deploy to Cloudflare,
or exercise a real payment. Those need Rigel. If a task depends on one of them, say so
plainly rather than mocking your way around it — mocking around a database guarantee is
exactly the failure mode described above.
