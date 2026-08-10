-- Forkable — step 5: reviews, ratings, demo health, and a security fix.
-- Run after payments.sql. Safe to re-run.

-- ================================================================= SECURITY FIX
-- Postgres runs a view with the privileges of the view's OWNER unless
-- security_invoker is on. The views in schema.sql and payments.sql were created
-- without it, which means they bypassed row-level security on the tables beneath
-- them: listings_with_seller would have shown draft and delisted listings to
-- anonymous visitors, because the `status = 'live' or seller_id = auth.uid()`
-- policy was never evaluated for the caller.
--
-- security_invoker = on makes the view evaluate RLS as the calling user, which is
-- what every one of these views assumed all along. Requires PG15+ (Supabase is).
--
-- Run this before putting a real listing anywhere near the site.

drop view if exists public.listings_with_seller;
drop view if exists public.payouts_due;
drop view if exists public.seller_earnings;

-- ================================================================= ratings
create or replace view public.listing_ratings
with (security_invoker = on) as
  select l.id                                        as listing_id,
         count(r.id)                                 as review_count,
         round(avg(r.rating)::numeric, 2)            as avg_rating
  from public.listings l
  left join public.purchases p on p.listing_id = l.id
  left join public.reviews   r on r.purchase_id = p.id
  group by l.id;

-- ================================================================= demo health
-- The entire pitch is "every listing has a working demo". Demos rot: a seller
-- lets a domain lapse, a free tier sleeps, a deploy breaks. Nothing else in the
-- product notices, so this does. sandbox_instances already existed for Phase 1
-- bookkeeping; these columns turn it into a health record.
alter table public.sandbox_instances
  add column if not exists last_checked_at      timestamptz,
  add column if not exists http_status          integer,
  add column if not exists latency_ms           integer,
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_error           text;

create unique index if not exists sandbox_instances_listing_key
  on public.sandbox_instances (listing_id);

-- Health is written by the checker with service_role, never by a seller — a
-- seller marking their own broken demo as healthy defeats the point.
revoke insert, update, delete on public.sandbox_instances from anon, authenticated;

-- ================================================================= public listing view
-- One view the browse grid and listing page both read: listing + seller + rating
-- + demo health. repo_url stays out of it, as in the original.
create view public.listings_with_seller
with (security_invoker = on) as
  select l.id, l.seller_id, l.title, l.short_description, l.long_description,
         l.category, l.price_cents, l.demo_url, l.setup_instructions,
         l.tech_stack_tags, l.status, l.created_at, l.updated_at,
         p.display_name                    as seller_name,
         p.bio                             as seller_bio,
         coalesce(lr.review_count, 0)      as review_count,
         lr.avg_rating                     as avg_rating,
         s.status                          as demo_status,
         s.last_checked_at                 as demo_last_checked_at,
         s.consecutive_failures            as demo_consecutive_failures
  from public.listings l
  join public.profiles p        on p.id = l.seller_id
  left join public.listing_ratings lr on lr.listing_id = l.id
  left join public.sandbox_instances s on s.listing_id = l.id;

-- ================================================================= seller profile view
-- Public seller page: what they've shipped and how it's been received. Deliberately
-- no email, no Stripe state, no counts of anything unsold.
create or replace view public.seller_public
with (security_invoker = on) as
  select p.id,
         p.display_name,
         p.bio,
         p.created_at,
         count(distinct l.id) filter (where l.status = 'live') as live_listing_count,
         coalesce(round(avg(r.rating)::numeric, 2), null)      as avg_rating,
         count(distinct r.id)                                  as review_count
  from public.profiles p
  left join public.listings l  on l.seller_id = p.id and l.status = 'live'
  left join public.purchases pu on pu.listing_id = l.id
  left join public.reviews   r  on r.purchase_id = pu.id
  group by p.id, p.display_name, p.bio, p.created_at;

-- ================================================================= recreate payout views
create view public.payouts_due
with (security_invoker = on) as
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

create view public.seller_earnings
with (security_invoker = on) as
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

-- ================================================================= reviews, readable
-- The listing page needs the reviewer's name and which listing each review is for,
-- without exposing the purchase (amount, refund state) behind it.
create or replace view public.reviews_public
with (security_invoker = on) as
  select r.id,
         r.rating,
         r.body,
         r.created_at,
         pu.listing_id,
         pr.display_name as reviewer_name
  from public.reviews r
  join public.purchases pu on pu.id = r.purchase_id
  join public.profiles  pr on pr.id = pu.buyer_id;

-- Every review is attached to a purchase by construction, so "verified purchase"
-- needs no extra column — it is unforgeable by design.
