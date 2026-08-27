-- Forkable — license tiers + the request board.
-- Run after changelog.sql. Safe to re-run.

-- ================================================================= license tiers
-- The buyers here are agencies who deploy the same tool for several clients.
-- One price for "use it on one project" and another for "use it on all of them"
-- is the same work for the seller and materially more revenue per sale. It is
-- how Envato and ThemeForest run their entire business.

do $$ begin
  create type license_tier as enum ('single', 'extended');
exception when duplicate_object then null; end $$;

alter table public.listings
  add column if not exists extended_price_cents integer;

-- listings carries column-level select grants (schema.sql), and ADD COLUMN does
-- not extend them — so without this the new price is invisible to the browse
-- grid and every listing silently loses its extended tier. Re-grant the public
-- columns, which now includes extended_price_cents.
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

-- Extended must cost more than single, or the tier is meaningless. Null means
-- the seller only offers the single-client license.
alter table public.listings
  drop constraint if exists listings_extended_price_check;
alter table public.listings
  add constraint listings_extended_price_check
  check (extended_price_cents is null or extended_price_cents > price_cents);

-- Which licence was bought is a permanent fact about the sale, not a lookup
-- against today's listing — the seller can re-price tomorrow.
alter table public.purchases
  add column if not exists license license_tier not null default 'single';

-- ================================================================= request board
-- A marketplace with no catalogue has nothing for a buyer to do. The board gives
-- demand somewhere to go before supply exists, and doubles as the most honest
-- market research available: people posting what they'd pay for.

create table if not exists public.requests (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null references public.profiles(id) on delete cascade,
  title        text not null,
  body         text not null default '',
  category     listing_category not null default 'other',
  budget_cents integer check (budget_cents is null or budget_cents >= 0),
  status       text not null default 'open'
                 check (status in ('open', 'fulfilled', 'closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists requests_status_idx   on public.requests (status, created_at desc);
create index if not exists requests_author_idx   on public.requests (author_id);

alter table public.requests enable row level security;

-- The board is public — that's the point. Anyone can read it, including people
-- who haven't signed up, because it's the best advertisement the site has.
drop policy if exists "requests are public" on public.requests;
create policy "requests are public" on public.requests for select using (true);

drop policy if exists "authors write own requests" on public.requests;
create policy "authors write own requests"
  on public.requests for insert to authenticated with check (author_id = auth.uid());

drop policy if exists "authors edit own requests" on public.requests;
create policy "authors edit own requests"
  on public.requests for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists "authors delete own requests" on public.requests;
create policy "authors delete own requests"
  on public.requests for delete to authenticated using (author_id = auth.uid());

drop trigger if exists requests_touch on public.requests;
create trigger requests_touch before update on public.requests
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- responses
-- A seller replies publicly: "I have this already" or "I'll build it for X".
-- Public replies mean the next buyer with the same need reads the answer too.
create table if not exists public.request_responses (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests(id) on delete cascade,
  seller_id   uuid not null references public.profiles(id) on delete cascade,
  body        text not null,
  listing_id  uuid references public.listings(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists request_responses_request_idx
  on public.request_responses (request_id, created_at);

-- One reply per seller per request keeps the board from turning into a pitch
-- wall; a seller who wants to say more can edit their existing reply.
create unique index if not exists request_responses_one_per_seller
  on public.request_responses (request_id, seller_id);

alter table public.request_responses enable row level security;

drop policy if exists "responses are public" on public.request_responses;
create policy "responses are public" on public.request_responses for select using (true);

drop policy if exists "sellers write own responses" on public.request_responses;
create policy "sellers write own responses"
  on public.request_responses for insert to authenticated with check (seller_id = auth.uid());

drop policy if exists "sellers edit own responses" on public.request_responses;
create policy "sellers edit own responses"
  on public.request_responses for update to authenticated
  using (seller_id = auth.uid()) with check (seller_id = auth.uid());

drop policy if exists "sellers delete own responses" on public.request_responses;
create policy "sellers delete own responses"
  on public.request_responses for delete to authenticated using (seller_id = auth.uid());

-- ---------------------------------------------------------------- board view
create or replace view public.requests_public
with (security_invoker = on) as
  select r.id, r.author_id, r.title, r.body, r.category, r.budget_cents,
         r.status, r.created_at, r.updated_at,
         p.display_name                    as author_name,
         coalesce(rr.response_count, 0)    as response_count
  from public.requests r
  join public.profiles p on p.id = r.author_id
  left join (
    select request_id, count(*) as response_count
    from public.request_responses
    group by request_id
  ) rr on rr.request_id = r.id;

create or replace view public.request_responses_public
with (security_invoker = on) as
  select rr.id, rr.request_id, rr.seller_id, rr.body, rr.listing_id, rr.created_at,
         p.display_name as seller_name,
         l.title        as listing_title
  from public.request_responses rr
  join public.profiles p on p.id = rr.seller_id
  left join public.listings l on l.id = rr.listing_id and l.status = 'live';

-- ================================================================= listing view
-- Recreated to carry extended_price_cents. Same shape as reviews_and_health.sql
-- otherwise — if you edit one, edit both.
drop view if exists public.listings_with_seller;
create view public.listings_with_seller
with (security_invoker = on) as
  select l.id, l.seller_id, l.title, l.short_description, l.long_description,
         l.category, l.price_cents, l.extended_price_cents,
         l.demo_url, l.setup_instructions,
         l.tech_stack_tags, l.status, l.created_at, l.updated_at,
         p.display_name                    as seller_name,
         p.bio                             as seller_bio,
         coalesce(lr.review_count, 0)      as review_count,
         lr.avg_rating                     as avg_rating,
         s.status                          as demo_status,
         s.last_checked_at                 as demo_last_checked_at,
         s.consecutive_failures            as demo_consecutive_failures,
         lu.update_count,
         lu.last_update_at,
         lu.latest_version
  from public.listings l
  join public.profiles p on p.id = l.seller_id
  left join public.listing_ratings lr        on lr.listing_id = l.id
  left join public.sandbox_instances s       on s.listing_id = l.id
  left join public.listing_update_summary lu on lu.listing_id = l.id;
