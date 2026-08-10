# Forkable

A builder-to-builder marketplace for reusable operational tools. Every listing is a
running app you can use before you pay, ships as a fork-and-deploy template, and is
covered by a refund window.

**Status: build order step 0 — validation landing page.** No auth, no payments, no
database beyond a waitlist table. That is deliberate.

---

## What's here

```
index.html              the landing page (vanilla, self-contained, no build step)
config.js               brand + Supabase keys + the featured listing data
supabase/waitlist.sql   waitlist table, unique index, RLS policy
demos/                  three real working apps, served as Phase 1 sandbox demos
```

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

## Turning on the real waitlist

Right now signups save to `localStorage` and the form says so. To make it real:

1. Create a Supabase project.
2. Run `supabase/waitlist.sql` in the SQL editor.
3. Put the project URL and the **anon** key into `config.js`.

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

**SquadCal** was considered as a fourth listing but is a Vite app that needs a build
step to demo, unlike the three single-file tools. Skipped for now rather than shipping
a listing whose demo doesn't run — the whole pitch is that every demo works.

## Next step

Step 1 is done when this page is deployed and collecting real emails. Step 2 is auth +
profiles + listing CRUD against the schema in the brief — no payments yet.
