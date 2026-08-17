# Get this repo onto GitHub

Written 2026-08-17. Two reasons to do this, in order of how much they'd hurt:

1. **There is no off-machine copy of this project.** 16 commits, ~6,100 lines of
   finished, tested work, in one directory on one Mac. No remote, no backup.
2. Cloud/browser Claude Code sessions work from a GitHub repo. Without this, a cloud
   session has no code to read.

Verified state: no git remote, `gh` not authenticated, no SSH keys, no `GH_TOKEN`.
None of your four repos (`marketplace`, `TrueStroke-AI`, `roblox-space-tycoon`,
`second-brain`) has ever been pushed.

---

## Step 1 — authenticate (only you can do this)

```bash
gh auth login
```

Choose **GitHub.com** → **HTTPS** → **Login with a web browser**, then paste the
one-time code it shows you into the browser page it opens. A session can't do this
step — it needs your actual GitHub login.

No GitHub account yet? Create one at github.com first, then run the command above.

## Step 2 — create the repo and push (one command)

```bash
cd ~/marketplace && gh repo create forkable --private --source=. --remote=origin --push
```

`--private` is deliberate: the repo contains no secrets, but nothing about this is
ready to be read by strangers yet, and the early history contains some local wrangler
runtime state that has no business being public. You can flip it to public later with
`gh repo edit --visibility public`.

## Step 3 — confirm it actually landed

```bash
cd ~/marketplace && git remote -v && git log --oneline -1 && gh repo view --web
```

You should see `origin` pointing at GitHub, `HEAD` at the same commit as local, and the
browser opening your repo with all 17 commits in it.

## Step 4 — point the cloud session at it

In the cloud session, open the repo you just created, then paste `HANDOFF.md` as the
first message. Everything else it needs is in the repo.

---

## Is it safe to push? — audited 2026-08-17

Yes. I checked, rather than assuming:

- **`.dev.vars` has never been committed** — it is gitignored (`.gitignore` covers
  `.env`, `.env.*`, `.dev.vars`, `node_modules/`, `.DS_Store`, `.wrangler/`) and
  `git log -- .dev.vars` across all refs is empty.
- **No real keys anywhere in history.** Scanned every commit for `sk_live_` / `sk_test_`
  / `whsec_` / `sk-ant-` / JWT-shaped strings. Every hit is prose or a placeholder
  regex in `preflight.mjs` — no actual credentials.
- **`config.js` holds only empty strings** for `supabaseUrl` / `supabaseAnonKey`, and
  only the **anon** key may ever go there anyway.
- **One wart:** `.wrangler/` miniflare runtime state was committed in the first few
  commits and untracked in `596db00`. Those blobs are still in history. I scanned them
  for key-shaped data and found none — all keys were placeholders at that time — but it
  is a second reason to keep the repo private.

**Keep it that way:** never commit `.dev.vars`, and never paste its contents into a
file, an issue, or a commit message. Once real keys exist, this audit does not
re-run itself.

---

## If you'd rather not use GitHub

`~/marketplace-backup.bundle` is a single-file copy of the entire repo, all 17 commits
and full history, made 2026-08-17. It is a real backup — restore it anywhere with:

```bash
git clone ~/marketplace-backup.bundle marketplace-restored
```

Keep a copy somewhere that isn't this Mac. It does **not** solve the cloud-session
problem — a browser session still needs GitHub — and it goes stale the moment you
commit again, so regenerate it with:

```bash
cd ~/marketplace && git bundle create ~/marketplace-backup.bundle --all
```
