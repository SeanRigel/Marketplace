-- Forkable — step 3: payments, payout holds, and the refund window.
-- Run after schema.sql. Safe to re-run.
--
-- The shape here follows the guarantee mechanic: money lands on the PLATFORM
-- account at checkout, and the seller's transfer is created only once the refund
-- window has closed. That is why there is no destination charge and why
-- payout_transfer_id starts null.

-- ---------------------------------------------------------------- profiles
alter table public.profiles
  add column if not exists stripe_charges_enabled boolean not null default false,
  add column if not exists stripe_payouts_enabled boolean not null default false,
  add column if not exists stripe_details_submitted boolean not null default false;

-- Connect state is decided by Stripe and written by the webhook, never the browser.
revoke update (stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted)
  on public.profiles from anon, authenticated;

-- Reads too — same reasoning as stripe_connect_id in schema.sql. These flags say
-- which sellers have finished onboarding and can take money, which is nobody
-- else's business. The seller's own dashboard gets them from /api/connect, which
-- reads with service_role, so revoking here costs the app nothing.
--
-- Re-apply the profiles column grants now that three columns have been added.
-- ALTER TABLE ADD COLUMN does not extend an existing column-level grant, so the
-- new flags are already unreadable — but this file is meant to be safe to re-run
-- on its own, and a plain `revoke select (col)` would be a silent no-op if the
-- table-level grant is somehow back. See the long note in schema.sql.
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name not in ('stripe_connect_id', 'stripe_charges_enabled',
                            'stripe_payouts_enabled', 'stripe_details_submitted');
  execute 'revoke select on public.profiles from anon, authenticated';
  execute format('grant select (%s) on public.profiles to anon, authenticated', cols);
end $$;

-- ---------------------------------------------------------------- purchases
alter table public.purchases
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_charge_id          text,
  add column if not exists seller_id                 uuid references public.profiles(id),
  add column if not exists payout_transfer_id        text,
  add column if not exists payout_released_at        timestamptz,
  add column if not exists refunded_at               timestamptz,
  add column if not exists refund_reason             text;

-- The webhook may be delivered more than once for the same session; Stripe
-- guarantees at-least-once, not exactly-once. This makes the retry a no-op.
create unique index if not exists purchases_checkout_session_key
  on public.purchases (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

-- Payout sweep looks for complete purchases past their window with no transfer yet.
create index if not exists purchases_payout_due_idx
  on public.purchases (refund_window_expires_at)
  where payout_transfer_id is null;

-- ---------------------------------------------------------------- fee settings
-- One row. Keeping the fee in the database (not an env var) means changing it is
-- an audited update rather than a redeploy, and historical purchases keep the
-- platform_fee_cents they were actually charged.
create table if not exists public.platform_settings (
  id                  boolean primary key default true check (id),
  platform_fee_bps    integer not null default 1500 check (platform_fee_bps between 0 and 5000),
  refund_window_days  integer not null default 14   check (refund_window_days between 1 and 90),
  updated_at          timestamptz not null default now()
);

insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

alter table public.platform_settings enable row level security;

-- Readable by everyone (the listing page quotes the refund window), writable by
-- nobody through the API — change it in the dashboard or with service_role.
drop policy if exists "settings are public" on public.platform_settings;
create policy "settings are public"
  on public.platform_settings for select using (true);

-- ---------------------------------------------------------------- payout view
-- What the sweep job consumes: purchases whose refund window has closed, that
-- were never refunded, and whose seller can actually receive money.
create or replace view public.payouts_due as
  select p.id            as purchase_id,
         p.amount_cents,
         p.platform_fee_cents,
         p.amount_cents - p.platform_fee_cents as seller_cents,
         p.stripe_charge_id,
         p.refund_window_expires_at,
         pr.id           as seller_profile_id,
         pr.stripe_connect_id
  from public.purchases p
  join public.listings l  on l.id = p.listing_id
  join public.profiles pr on pr.id = l.seller_id
  where p.status = 'complete'
    and p.payout_transfer_id is null
    and p.refund_window_expires_at <= now()
    and pr.stripe_connect_id is not null
    and pr.stripe_payouts_enabled;

-- ---------------------------------------------------------------- seller earnings
-- Seller dashboard numbers, split by whether the guarantee window has closed.
create or replace view public.seller_earnings as
  select l.seller_id,
         count(*) filter (where p.status = 'complete')                          as sales_count,
         coalesce(sum(p.amount_cents - p.platform_fee_cents)
           filter (where p.status = 'complete' and p.payout_released_at is not null), 0) as paid_out_cents,
         coalesce(sum(p.amount_cents - p.platform_fee_cents)
           filter (where p.status = 'complete' and p.payout_released_at is null), 0)     as held_cents,
         count(*) filter (where p.status = 'refunded')                          as refund_count
  from public.purchases p
  join public.listings l on l.id = p.listing_id
  group by l.seller_id;
