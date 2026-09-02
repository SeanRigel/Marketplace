-- Forkable — step 2 schema: profiles, listings, purchases, reviews, sandbox_instances.
-- Run after supabase/waitlist.sql. Safe to re-run.
--
-- Payments are NOT wired yet (step 3), but purchases + refund_window_expires_at exist
-- from day one because the guarantee mechanic is painful to retrofit.

-- ---------------------------------------------------------------- enums
do $$ begin
  create type user_role         as enum ('seller', 'buyer', 'both');
  create type listing_category  as enum ('ai_agents','trading_bots','scheduling','dashboard','intake_form','payroll','ai_integration','other');
  create type listing_status    as enum ('draft','pending_review','live','delisted');
  create type purchase_status   as enum ('pending','complete','refunded','disputed');
  create type sandbox_status    as enum ('provisioning','live','expired','error');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id                uuid primary key references auth.users on delete cascade,
  role              user_role not null default 'both',
  display_name      text not null default '',
  bio               text,
  stripe_connect_id text,
  created_at        timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Seller identity is public: buyers need to see who is behind a listing.
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public"
  on public.profiles for select using (true);

drop policy if exists "own profile insert" on public.profiles;
create policy "own profile insert"
  on public.profiles for insert to authenticated with check (auth.uid() = id);

drop policy if exists "own profile update" on public.profiles;
create policy "own profile update"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- stripe_connect_id is written by the server during Connect onboarding (step 3),
-- never by the browser. Lock it out of client writes now so the hole never exists.
revoke update (stripe_connect_id) on public.profiles from anon, authenticated;

-- ...and out of client READS, which is a separate grant and easy to forget.
-- "profiles are public" is `using (true)`, so without this every visitor could
-- pull the whole seller roster's Connect account ids straight off
-- /rest/v1/profiles?select=stripe_connect_id. The seller_public view exists to
-- decide what is public; it only means something if the table underneath it is
-- not readable column-for-column.
--
-- Safe to revoke: nothing in the browser reads this column. Every server path
-- that needs it (connect.js, checkout.js, release-payouts.js) goes through
-- sbAdmin with service_role, which column privileges do not restrict.
--
-- ...but `revoke select (col)` alone DOES NOT WORK, and fails silently.
-- Postgres treats a TABLE-level select grant as implying select on every column,
-- and a column-level revoke cannot subtract from it. Supabase grants anon and
-- authenticated table-level select on new tables in public, so the obvious
-- one-liner is a no-op that reports success. The only thing that actually works
-- is to drop the table grant and grant back the columns that really are public.
--
-- Check it, don't assume it:
--   select has_column_privilege('anon','public.profiles','stripe_connect_id','SELECT');
-- must return false.
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

-- A profile row must exist for every user; do it in a trigger so signup can't
-- half-succeed and leave an authenticated user with no profile.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data ->> 'role')::user_role, 'both')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- listings
create table if not exists public.listings (
  id                 uuid primary key default gen_random_uuid(),
  seller_id          uuid not null references public.profiles(id) on delete cascade,
  title              text not null,
  short_description  text not null default '',
  long_description   text not null default '',
  category           listing_category not null default 'other',
  price_cents        integer not null default 0 check (price_cents >= 0),
  repo_url           text,
  demo_url           text,
  setup_instructions text,
  tech_stack_tags    text[] not null default '{}',
  status             listing_status not null default 'draft',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists listings_seller_idx   on public.listings (seller_id);
create index if not exists listings_status_idx   on public.listings (status);
create index if not exists listings_category_idx on public.listings (category);

alter table public.listings enable row level security;

-- Live listings are world-readable; a seller always sees their own drafts.
drop policy if exists "live listings are public" on public.listings;
create policy "live listings are public"
  on public.listings for select
  using (status = 'live' or seller_id = auth.uid());

drop policy if exists "sellers insert own listings" on public.listings;
create policy "sellers insert own listings"
  on public.listings for insert to authenticated with check (seller_id = auth.uid());

drop policy if exists "sellers update own listings" on public.listings;
create policy "sellers update own listings"
  on public.listings for update to authenticated
  using (seller_id = auth.uid()) with check (seller_id = auth.uid());

drop policy if exists "sellers delete own listings" on public.listings;
create policy "sellers delete own listings"
  on public.listings for delete to authenticated using (seller_id = auth.uid());

-- repo_url is the thing being sold. RLS is row-level, so a policy alone would leak
-- it to anyone who can see the row. Column privileges close that: nobody reads it
-- over the API, and buyers go through listing_repo_url() below.
-- Same trap as profiles above: a column-level revoke is a silent no-op while the
-- table-level grant exists. Drop it, then grant back everything except repo_url.
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'listings'
    and column_name <> 'repo_url';
  execute 'revoke select on public.listings from anon, authenticated';
  execute format('grant select (%s) on public.listings to anon, authenticated', cols);
end $$;

create or replace function public.listing_repo_url(p_listing uuid)
returns text language plpgsql security definer stable set search_path = public as $$
declare v_url text;
begin
  select l.repo_url into v_url
  from public.listings l
  where l.id = p_listing
    and (
      l.seller_id = auth.uid()                        -- the seller owns it
      or exists (                                     -- or the caller bought it
        select 1 from public.purchases p
        where p.listing_id = l.id
          and p.buyer_id   = auth.uid()
          and p.status     = 'complete'
      )
    );
  return v_url;  -- null when the caller has no claim to it
end $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists listings_touch on public.listings;
create trigger listings_touch before update on public.listings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- purchases
create table if not exists public.purchases (
  id                       uuid primary key default gen_random_uuid(),
  listing_id               uuid not null references public.listings(id) on delete restrict,
  buyer_id                 uuid not null references public.profiles(id) on delete cascade,
  stripe_payment_intent_id text unique,
  amount_cents             integer not null check (amount_cents >= 0),
  platform_fee_cents       integer not null default 0 check (platform_fee_cents >= 0),
  status                   purchase_status not null default 'pending',
  refund_window_expires_at timestamptz not null default now() + interval '14 days',
  created_at               timestamptz not null default now()
);

create index if not exists purchases_buyer_idx   on public.purchases (buyer_id);
create index if not exists purchases_listing_idx on public.purchases (listing_id);

alter table public.purchases enable row level security;

-- Buyer sees their own; seller sees purchases of their listings. Nobody else.
drop policy if exists "buyer or seller can read purchase" on public.purchases;
create policy "buyer or seller can read purchase"
  on public.purchases for select to authenticated
  using (
    buyer_id = auth.uid()
    or exists (select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid())
  );

-- No insert/update policy on purpose: rows are written by the Stripe webhook using
-- the service_role key. A browser must never be able to mint a purchase.

-- ---------------------------------------------------------------- reviews
create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.purchases(id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  body        text,
  created_at  timestamptz not null default now()
);

alter table public.reviews enable row level security;

drop policy if exists "reviews are public" on public.reviews;
create policy "reviews are public" on public.reviews for select using (true);

-- Only the actual buyer of that purchase may review it — one review per purchase
-- is enforced by the unique constraint above.
drop policy if exists "buyer writes own review" on public.reviews;
create policy "buyer writes own review"
  on public.reviews for insert to authenticated
  with check (exists (
    select 1 from public.purchases p
    where p.id = purchase_id and p.buyer_id = auth.uid() and p.status = 'complete'
  ));

drop policy if exists "buyer edits own review" on public.reviews;
create policy "buyer edits own review"
  on public.reviews for update to authenticated
  using (exists (select 1 from public.purchases p where p.id = purchase_id and p.buyer_id = auth.uid()));

-- ---------------------------------------------------------------- sandbox_instances
-- Phase 1 = seller-hosted demos, so this is bookkeeping only for now.
create table if not exists public.sandbox_instances (
  id            uuid primary key default gen_random_uuid(),
  listing_id    uuid not null references public.listings(id) on delete cascade,
  status        sandbox_status not null default 'live',
  url           text,
  last_reset_at timestamptz
);

alter table public.sandbox_instances enable row level security;

drop policy if exists "sandboxes readable with listing" on public.sandbox_instances;
create policy "sandboxes readable with listing"
  on public.sandbox_instances for select
  using (exists (
    select 1 from public.listings l
    where l.id = listing_id and (l.status = 'live' or l.seller_id = auth.uid())
  ));

-- ---------------------------------------------------------------- public seller view
-- Browse needs a seller name next to each listing without exposing anything else.
create or replace view public.listings_with_seller as
  select l.id, l.seller_id, l.title, l.short_description, l.long_description,
         l.category, l.price_cents, l.demo_url, l.setup_instructions,
         l.tech_stack_tags, l.status, l.created_at, l.updated_at,
         p.display_name as seller_name
  from public.listings l
  join public.profiles p on p.id = l.seller_id;
