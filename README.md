# Forkable

A builder-to-builder marketplace for reusable operational tools. Every listing is a
running app you can use before you pay, ships as a fork-and-deploy template, and is
covered by a refund window.

**Status: steps 0–2 done.** Validation landing page, plus auth, profiles, and listing
CRUD. No payments — that's step 3.

---

## What's here

```
index.html              the landing page (vanilla, self-contained, no build step)
app.html                the app shell — #/browse, #/listing/<id>, #/auth, #/dashboard/*
app/db.js               data layer: Supabase backend | local backend, one interface
app/app.js              hash router + views
app/style.css           app styling (same tokens as the landing page)
config.js               brand + Supabase keys + the featured listing data
supabase/waitlist.sql   waitlist table, unique index, RLS policy
supabase/schema.sql     profiles, listings, purchases, reviews, sandbox_instances + RLS
demos/                  three real working apps, served as Phase 1 sandbox demos
```

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
python3 -m http.server 4321 --directory ~/marketplace
```

Then open <http://localhost:4321>. It must be served over HTTP, not opened as a
`file://` path — the demo iframes won't load otherwise.

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

**Stripe Connect prerequisites.** Not blocking step 0, but worth knowing before step 3:
a Connect *platform* needs a real business entity, a completed platform profile, and
acceptance of the Connect ToS — it's a heavier setup than a normal Stripe account.
Holding payout until the refund window closes also means separate charges and
transfers with `transfer_data` deferred, not the default destination-charge flow.
Budget real time for this; it's the longest lead-time item in the plan.

**Platform fee.** Not set anywhere yet. The brief says 15–20%; it only needs to be a
real number when checkout gets built.

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

## Next step

**Step 3: Stripe Connect.** Real checkout, platform fee, and payout held until the
refund window closes. Start the Connect platform paperwork before writing code — see
the note above; it's the longest lead-time item in the plan.

Two things worth doing alongside it, both currently stubbed:
- `purchases` rows unlock `repo_url` — the plumbing exists, nothing writes to it yet.
- Reviews are in the schema with policies, but have no UI.
