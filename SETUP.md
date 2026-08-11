# Setup

Everything that needs an account you own. Roughly 2–3 hours of clicking, most of it
waiting on Stripe.

Work in **test mode** the whole way through. Do not switch to live keys until the last
section, and never paste a secret key into `config.js` or anything under `app/`.

Check your progress at any point with:

```bash
node scripts/preflight.mjs
```

It exits non-zero until things are genuinely right, and it will tell you specifically
if the public can read `repo_url` or mint their own purchases.

---

## 1. Supabase (~20 min)

1. Create a project at [supabase.com](https://supabase.com). Any region near you;
   the free tier is fine. Save the database password somewhere safe — you won't need
   it for this app, but you can't recover it.
2. Wait for provisioning to finish (~2 min).
3. Open **SQL Editor** and run these six files in order, one at a time. Each should
   report success before you run the next:
   - `supabase/waitlist.sql`
   - `supabase/schema.sql`
   - `supabase/payments.sql`
   - `supabase/reviews_and_health.sql`
   - `supabase/changelog.sql`
   - `supabase/licenses_and_requests.sql`

   ⚠️ **The fourth file is not optional.** Besides reviews and demo health, it fixes a
   security hole: views created without `security_invoker = on` run with the view
   owner's privileges and bypass row-level security, which means draft and delisted
   listings would be visible to anyone. `preflight.mjs` checks for this specifically.
4. Go to **Project Settings → API** and copy:
   - Project URL
   - `anon` `public` key
   - `service_role` key ⚠️

**The two keys are not interchangeable.** `anon` is public and belongs in `config.js`.
`service_role` bypasses every security policy in the database — it goes only in
`.dev.vars` and the Cloudflare dashboard. If it ever lands in a file under `app/` or
in `config.js`, rotate it immediately.

5. Under **Authentication → Providers**, keep Email enabled. While testing, turning
   *Confirm email* off makes signup instant. Turn it back on before launch.

Now fill in `config.js` (project URL + anon key). Reload the app — the cyan "Local
mode" banner should disappear. That's your proof the frontend is talking to Postgres.

---

## 2. Stripe (~1 hr, mostly waiting)

This is the long pole. Start it before you need it.

1. Create an account at [stripe.com](https://stripe.com), then go to
   **Connect → Get started** and enable it.
2. Complete the **platform profile**. Stripe asks what your marketplace does, who
   sells on it, and who bears fraud risk. Answer honestly: builders selling software
   templates to other builders, platform holds funds until a refund window closes.
   Review can take anywhere from minutes to a couple of days.
3. Set the **Connect account type** to **Express**.
4. From **Developers → API keys**, copy your **test** secret key (`sk_test_…`).

### Webhook

5. **Developers → Webhooks → Add endpoint**.
   - URL: `https://<your-pages-domain>/api/webhook`
   - Events: `checkout.session.completed`, `charge.refunded`, `account.updated`
6. Copy the **signing secret** (`whsec_…`).

For local testing you can skip the dashboard endpoint and use the CLI instead:

```bash
stripe listen --forward-to http://localhost:8788/api/webhook
```

It prints its own `whsec_…` — use that one in `.dev.vars` while developing.

---

## 3. Local run (~10 min)

```bash
cp .dev.vars.example .dev.vars
```

Fill in all seven values. Generate the cron secret with something like:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:

```bash
node scripts/preflight.mjs
npx wrangler pages dev .
```

Plain `python3 -m http.server` serves the static files but **not** `/api/*` — you need
wrangler for anything involving payments.

Walk the whole loop yourself at <http://localhost:8788/app.html>:

1. Sign up, create a listing with a demo URL, set it live.
2. Sign up as a second user and buy it — card `4242 4242 4242 4242`, any future
   expiry, any CVC.
3. Confirm the repo URL appears in Purchases and the countdown shows 14 days.
4. Refund it. Confirm access disappears and Stripe shows the refund.

If step 2 fails with "seller has not finished payment setup", that's correct
behaviour — connect the seller account first via **Set up payouts** on the seller
dashboard, and complete Stripe's test onboarding.

---

## 4. Deploy (~20 min)

```bash
npx wrangler login
npx wrangler pages deploy .
```

Then in the Cloudflare dashboard, under **Workers & Pages → your project → Settings →
Environment variables**, add all seven variables from `.dev.vars`. Mark the secrets as
**encrypted**. Redeploy after adding them — variables are not picked up retroactively.

Update `SITE_URL` to your real domain and point the Stripe webhook at
`https://<your-domain>/api/webhook`.

---

## 5. Schedule the payout sweep ⚠️

**Sellers are never paid until something calls this on a schedule.** Cloudflare Pages
Functions have no cron trigger, so this is the one piece of infrastructure that lives
outside the project.

Pick whichever you'll actually maintain:

**GitHub Action** (`.github/workflows/payouts.yml`, secret `CRON_SECRET`):

```yaml
on:
  schedule: [{ cron: "0 9 * * *" }]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST https://YOUR-DOMAIN/api/release-payouts \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

**Supabase pg_cron** — enable `pg_cron` and `pg_net`, then schedule a daily
`net.http_post` to the same URL with the same header.

**cron-job.org** — free, no code, fine to start with.

Verify it works before trusting it:

```bash
curl -X POST https://YOUR-DOMAIN/api/release-payouts -H "Authorization: Bearer $CRON_SECRET"
```

An empty `{"released":0,"results":[]}` is the correct answer when nothing is due yet.

### Schedule the demo health check too

Same mechanism, same secret, different endpoint. The entire pitch is that every listing
has a working demo; demos rot quietly, and nothing else notices.

```bash
curl -X POST https://YOUR-DOMAIN/api/check-demos -H "Authorization: Bearer $CRON_SECRET"
```

Daily is fine. It marks a demo `error` only after two consecutive failures, so one blip
doesn't put a "demo down" badge on someone's listing. It never auto-delists — that's a
judgement call to make once you know how noisy real checks are.

---

## 6. Going live

Only after the full test-mode loop works end to end:

1. Activate the Stripe account (business details, bank account).
2. Swap `sk_test_…` for `sk_live_…` in Cloudflare — **not** in any committed file.
3. Create a **live-mode** webhook endpoint; its signing secret is different from the
   test one. Update `STRIPE_WEBHOOK_SECRET`.
4. Re-run `node scripts/preflight.mjs`. It warns when you're on a live key.
5. Buy one of your own listings with a real card for a small amount, then refund it.
   Confirm the money actually moves both ways before inviting anyone.

**Set a spend/volume alert in the Stripe dashboard now**, while you're thinking about
it. Same reasoning as capping an API key: the cost of the alert is zero and the cost
of not having one is discovering a problem a day late.

---

## What breaks first

| Symptom | Cause |
| --- | --- |
| "Local mode" banner won't go away | `config.js` still blank, or the URL has a trailing slash |
| Signup succeeds, nothing in `profiles` | `schema.sql` wasn't run — the trigger creates that row |
| Purchases never appear after paying | Webhook not reaching you. Check **Developers → Webhooks → attempts** |
| Webhook shows 400 | Wrong `STRIPE_WEBHOOK_SECRET` — test and live secrets differ |
| "seller has not finished payment setup" | Correct. The seller hasn't completed Connect onboarding |
| Sellers never get paid | Nothing is calling `/api/release-payouts`. See section 5 |
| Preflight: "PUBLIC CAN READ repo_url" | `schema.sql` didn't finish. Re-run it and check for errors |
