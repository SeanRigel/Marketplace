# Start here

Plain checklist. Do these in order. Tick them off.

There is no more code to write. This is all clicking and copy-pasting.

> This file covers the next few hours. For the whole picture — everything built,
> everything left, and what blocks opening up to other sellers — see
> **[ROADMAP.md](ROADMAP.md)**.

**The one thing to understand before you start:** Stripe is the only slow step — a
real person reviews your platform profile and that can take days. Nothing else here
waits on anything. So you kick Stripe off first, then you build and *publish* the
rest while it sits in review. By the end of Phase 3 the site is on the internet
collecting real signups, with Stripe still pending. That's deliberate.

---

## Phase 1 — Kick off Stripe (do this FIRST, ~20 min)

You are not setting up payments today. You are getting in the review queue today.

- [ ] 1. Go to **stripe.com** and make an account.
- [ ] 2. In the left menu, find **Connect** and click **Get started**.
- [ ] 3. Fill in the platform profile. When it asks what your marketplace does, say
      something like: *"Developers sell reusable software templates to other
      developers. The platform holds funds until a 14-day refund window closes."*
- [ ] 4. When it asks about account type, choose **Express**.
- [ ] 5. Go to **Developers → API keys**. Copy the **test** secret key. It starts with
      `sk_test_`. Paste it somewhere safe for now.

✅ **Done with Phase 1 when:** you have a key starting with `sk_test_`.

Stripe may say your profile is "under review". That's fine and expected. **Do not
wait for it.** Go straight to Phase 2.

---

## Phase 2 — Set up the database (~30 min)

- [ ] 1. Go to **supabase.com**, make an account, click **New project**.
- [ ] 2. Name it `forkable`. Pick the region closest to you. It makes you set a
      database password — save it somewhere, you can't get it back.
- [ ] 3. Wait about 2 minutes for it to finish building.
- [ ] 4. In the left menu click **SQL Editor**, then **New query**.
- [ ] 5. Now you're going to run 6 files, **one at a time, in this exact order**.

      For each one: open the file, select all, copy, paste into the SQL Editor,
      click **Run**. Wait for "Success". Then clear it and do the next one.

      1. `supabase/waitlist.sql`
      2. `supabase/schema.sql`
      3. `supabase/payments.sql`
      4. `supabase/reviews_and_health.sql`
      5. `supabase/changelog.sql`
      6. `supabase/licenses_and_requests.sql`
      7. `supabase/import_quota.sql`
      8. `supabase/moderation.sql`
      9. `supabase/demo_gate.sql`
     10. `supabase/security_hardening.sql`
     11. `supabase/deploy_guide.sql`
     12. `supabase/agent_categories.sql`

      ⚠️ Don't skip #4. It fixes a security hole that would let strangers see your
      unfinished draft listings.

      ⚠️ Don't skip #9. Without it, demos are infinite free use — anyone can
      bookmark `/demos/...` forever. That file hides `demo_url`, adds the timed
      daily trial, and is required for `/api/demo-session` to work.

- [ ] 6. In the left menu click **Settings** (the gear) → **API**. You need three
      things off this page:
      - **Project URL**
      - **anon public** key
      - **service_role** key

      The `anon` key is safe to put in public code. The `service_role` key is **not** —
      it ignores all your security rules. Never put it in `config.js`.

- [ ] 7. Open `~/marketplace/config.js`. Near the top you'll see two empty quotes.
      Paste your Project URL and your **anon** key in:

      ```js
      supabaseUrl: 'https://yourproject.supabase.co',
      supabaseAnonKey: 'eyJhbGci...',
      ```

- [ ] 8. Open the app in your browser and reload.

✅ **Done with Phase 2 when:** the blue "Local mode" banner at the top is **gone**.

---

## Phase 3 — Put it on the internet (~20 min) ← do this today

Stripe is still in review. Publish anyway.

The landing page doesn't touch Stripe at all — the waitlist form talks straight to
Supabase, and all three demos are static files served from this same site. So the
whole pitch works right now: a stranger can land, click into a real running tool, and
leave you their email. That is the thing you're actually trying to validate, and
you don't need payments to find out.

- [ ] 1. ```bash
      cd ~/marketplace
      npx wrangler login
      npx wrangler pages deploy .
      ```

- [ ] 2. It gives you a URL. Write it down — this is your real address now.
- [ ] 3. Open it on your phone. Click into a demo. Submit the waitlist form with your
      own email.
- [ ] 4. Check the email actually landed: Supabase → **Table Editor** → `waitlist`.

✅ **Done with Phase 3 when:** you submitted the form on your phone and saw the row
appear in Supabase.

**Now go get people to look at it.** Everything below is plumbing you can finish this
week; the only question that matters is whether strangers who use a demo want the
tool. Start asking that today.

> Buying is dead until Phase 5 — that's expected, and the site says so. If someone
> clicks Buy they get *"This part of the site isn't switched on yet."* No stack
> traces, no missing-key names.

---

## Phase 4 — Wire up payments on your Mac (~30 min)

Come back to this when Stripe has approved your profile.

- [ ] 1. In Terminal:

      ```bash
      cd ~/marketplace
      cp .dev.vars.example .dev.vars
      ```

- [ ] 2. Open `.dev.vars` and fill in the 7 required lines. Six you already have. For
      the last one (`CRON_SECRET`) run this and paste the result:

      ```bash
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
      ```

      There's an 8th line, `ANTHROPIC_API_KEY`. It's **optional** — it only powers
      "draft a listing from a GitHub repo". Leave it blank and that one button is off;
      everything else works. If you do add it, **set a spend limit in the Anthropic
      console first** — every click on that button costs money.

- [ ] 3. Check your work:

      ```bash
      node scripts/preflight.mjs
      ```

      This tells you exactly what's wrong, in plain English. Fix whatever it lists and
      run it again until it says **Ready**.

- [ ] 4. Start the real server (the normal one doesn't handle payments):

      ```bash
      npx wrangler pages dev .
      ```

- [ ] 5. Open the address it prints. Now test the whole thing yourself:
      - Sign up, create a listing, put in a demo URL, set it to Live
      - Sign up as a **second** user (different email), buy it
      - Use test card `4242 4242 4242 4242`, any future date, any 3 digits
      - Check the repo link appears under Purchases
      - Click **Request refund**, check it goes away

      If buying fails with *"seller has not finished payment setup"* — that's correct.
      Go to the Selling tab as your seller account, click **Set up payouts**, and
      complete Stripe's test form.

✅ **Done with Phase 4 when:** you've bought and refunded your own listing on
localhost.

---

## Phase 5 — Turn payments on in public (~20 min)

Your site is already deployed from Phase 3. This just gives it its keys.

- [ ] 1. Go to the **Cloudflare dashboard → Workers & Pages → your project →
      Settings → Environment variables**. Add all 7 variables from your `.dev.vars`.
      Tick **encrypt** on the secret ones.
- [ ] 2. Change `SITE_URL` to your real deployed URL (not localhost).
- [ ] 3. Deploy again — **variables don't apply to deploys that already happened**:

      ```bash
      npx wrangler pages deploy .
      ```

- [ ] 4. Back in Stripe: **Developers → Webhooks → Add endpoint**.
      - URL: `https://YOUR-URL/api/webhook`
      - Pick these 3 events: `checkout.session.completed`, `charge.refunded`,
        `account.updated`
- [ ] 5. Copy the signing secret it gives you (starts with `whsec_`). Update
      `STRIPE_WEBHOOK_SECRET` in Cloudflare, and deploy once more.

✅ **Done with Phase 5 when:** you can buy something on the real URL.

---

## Phase 6 — Turn on the two robots (~20 min) ⚠️ Don't skip

Two jobs need to run on a schedule. Cloudflare can't do this by itself.

**Without #1, sellers never get their money.** Not a bug you'd notice — it just
silently never happens.

- [ ] 1. **Pay sellers** — `POST https://YOUR-URL/api/release-payouts`
- [ ] 2. **Check demos still work** — `POST https://YOUR-URL/api/check-demos`

Both need this header: `Authorization: Bearer YOUR_CRON_SECRET`

Easiest way: go to **cron-job.org**, make a free account, add both as daily jobs.
(You can also use a GitHub Action — example is in SETUP.md.)

- [ ] 3. Test one by hand first:

      ```bash
      curl -X POST https://YOUR-URL/api/release-payouts \
        -H "Authorization: Bearer YOUR_CRON_SECRET"
      ```

      Getting `{"released":0,"results":[]}` back is correct — it means it works and
      nobody is owed money yet.

✅ **Done with Phase 6 when:** both jobs are scheduled and you tested one.

---

## Phase 7 — Real money (~30 min)

Only after everything above works.

- [ ] 1. In Stripe, finish activating the account (real business details, bank account).
- [ ] 2. **Set a spend alert in Stripe right now**, while you're thinking about it.
- [ ] 3. Swap `sk_test_` for your `sk_live_` key in **Cloudflare only**. Never in a file.
- [ ] 4. Make a **new** webhook in live mode. Its secret is different from the test one.
      Update `STRIPE_WEBHOOK_SECRET`.
- [ ] 5. Run `node scripts/preflight.mjs` again. It warns you when you're on a live key.
- [ ] 6. Buy one of your own listings with a real card for a few dollars. Then refund it.
      Watch the money actually leave and come back before you invite anyone.

✅ **Done when:** you've moved real money both directions.

---

## Then

List your 3 real tools properly. Get one stranger to buy one.

The whole point of this build is one question: **does letting people use the tool
before they pay, plus a real refund button, actually make them buy?** You can't answer
that with more features. Only with strangers.

---

## If something breaks

| What you see | What it means |
| --- | --- |
| Blue "Local mode" banner won't go away | `config.js` is empty, or the URL has an extra `/` at the end |
| Signed up but nothing in `profiles` | You skipped `schema.sql` |
| "This part of the site isn't switched on yet." | A route needs env vars you haven't set in Cloudflare yet. Normal before Phase 5. Run `npx wrangler tail` to see which variable |
| Paid but no purchase shows up | Webhook isn't reaching you. Stripe → Developers → Webhooks → look at attempts |
| Webhook says 400 | Wrong `STRIPE_WEBHOOK_SECRET`. Test and live secrets are different |
| "seller has not finished payment setup" | Correct. That seller needs to click **Set up payouts** |
| Sellers never get paid | Phase 6. Nothing is calling the payout job |
| preflight says "PUBLIC CAN READ ..." | A SQL file didn't finish. Preflight prints the exact one-line `revoke` to paste into the SQL editor — use that, **don't** re-run `schema.sql` (it aborts partway now that later files reshape `listings_with_seller`) |

Run this any time to check the code is fine:

```bash
./scripts/test.sh
```

> `SETUP.md` is the longer reference version of all this. It groups things by system
> (Supabase, Stripe, deploy, crons) rather than by what to do first, so its numbering
> doesn't match the phases here. When they disagree about *order*, follow this file.
