-- Forkable — timed daily demo gate.
-- Run AFTER moderation.sql (last schema file). Safe to re-run.
--
-- The pitch is "use before you pay". Without a gate, that is infinite free use
-- of the full tool via a public demo_url or /demos/... bookmark. This file:
--
--   1. Hides demo_url from anon/authenticated SELECT (same class as repo_url)
--   2. Exposes has_demo so browse/listing UI still know a demo exists
--   3. Mints one timed session per visitor per demo per UTC day
--   4. Sellers and completed buyers get unlimited sessions
--
-- The Pages Functions /api/demo-session and /api/demo-launch + the /demos/*
-- asset gate enforce this. SQL alone is not enough — static files would still
-- be reachable — but without these tables the Functions have nothing to claim.

-- ---------------------------------------------------------------- has_demo
-- Public signal that a demo exists, without revealing the durable URL.
-- Trigger-synced so listings_with_seller never needs to read demo_url under
-- security_invoker (callers have no SELECT on that column after the revoke).

alter table public.listings
  add column if not exists has_demo boolean not null default false;

update public.listings
   set has_demo = (demo_url is not null and length(trim(demo_url)) > 0)
 where has_demo is distinct from (demo_url is not null and length(trim(demo_url)) > 0);

create or replace function public.listings_sync_has_demo()
returns trigger language plpgsql as $$
begin
  new.has_demo := (new.demo_url is not null and length(trim(new.demo_url)) > 0);
  return new;
end $$;

drop trigger if exists listings_sync_has_demo on public.listings;
create trigger listings_sync_has_demo
  before insert or update of demo_url on public.listings
  for each row execute function public.listings_sync_has_demo();

-- ---------------------------------------------------------------- column privileges
-- Scar #5/#6: a column-level revoke is a silent no-op under a table-level grant.
-- Drop the table grant, then grant back every column except repo_url and demo_url.

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'listings'
    and column_name not in ('repo_url', 'demo_url');
  execute 'revoke select on public.listings from anon, authenticated';
  execute format('grant select (%s) on public.listings to anon, authenticated', cols);
end $$;

-- Seller or completed buyer may read the durable demo URL (edit form, purchases).
create or replace function public.listing_demo_url(p_listing uuid)
returns text language plpgsql security definer stable set search_path = public as $$
declare v_url text;
begin
  select l.demo_url into v_url
  from public.listings l
  where l.id = p_listing
    and (
      l.seller_id = auth.uid()
      or exists (
        select 1 from public.purchases p
        where p.listing_id = l.id
          and p.buyer_id   = auth.uid()
          and p.status     = 'complete'
      )
    );
  return v_url;
end $$;

revoke all on function public.listing_demo_url(uuid) from public;
grant execute on function public.listing_demo_url(uuid) to anon, authenticated;

-- ---------------------------------------------------------------- settings
alter table public.platform_settings
  add column if not exists demo_trial_minutes integer not null default 30
    check (demo_trial_minutes between 1 and 1440);

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'platform_settings';
  execute 'revoke select on public.platform_settings from anon, authenticated';
  execute format('grant select (%s) on public.platform_settings to anon, authenticated', cols);
end $$;

-- ---------------------------------------------------------------- sessions
create table if not exists public.demo_sessions (
  id           uuid primary key default gen_random_uuid(),
  demo_key     text not null,
  visitor_key  text not null,
  day          date not null default (timezone('utc', now()))::date,
  expires_at   timestamptz not null,
  unlimited    boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (demo_key, visitor_key, day)
);

create index if not exists demo_sessions_id_lookup
  on public.demo_sessions (id);

create index if not exists demo_sessions_day_idx
  on public.demo_sessions (day);

alter table public.demo_sessions enable row level security;

-- Server-only. A visitor who could UPDATE their own row could extend forever.
revoke all on public.demo_sessions from anon, authenticated;

-- Claim or resume today's session. Called only with service_role from Functions.
--
-- Returns: allowed, reason ('ok'|'exhausted'|'invalid'), session_id, expires_at, unlimited
create or replace function public.claim_demo_session(
  p_demo_key    text,
  p_visitor_key text,
  p_unlimited   boolean default false
)
returns table (
  allowed     boolean,
  reason      text,
  session_id  uuid,
  expires_at  timestamptz,
  unlimited   boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_minutes integer;
  v_today   date := (timezone('utc', now()))::date;
  v_row     public.demo_sessions%rowtype;
  v_exp     timestamptz;
begin
  if p_demo_key is null or length(trim(p_demo_key)) = 0
     or p_visitor_key is null or length(trim(p_visitor_key)) = 0 then
    return query select false, 'invalid', null::uuid, null::timestamptz, false;
    return;
  end if;

  select demo_trial_minutes into v_minutes
  from public.platform_settings limit 1;
  v_minutes := coalesce(v_minutes, 30);

  select * into v_row
  from public.demo_sessions
  where demo_key = p_demo_key
    and visitor_key = p_visitor_key
    and day = v_today;

  if p_unlimited then
    v_exp := timezone('utc', now()) + interval '24 hours';
    if v_row.id is null then
      insert into public.demo_sessions (demo_key, visitor_key, day, expires_at, unlimited)
      values (p_demo_key, p_visitor_key, v_today, v_exp, true)
      returning * into v_row;
    else
      update public.demo_sessions
         set expires_at = v_exp, unlimited = true
       where id = v_row.id
      returning * into v_row;
    end if;
    return query select true, 'ok', v_row.id, v_row.expires_at, true;
    return;
  end if;

  -- Resume an active trial.
  if v_row.id is not null and v_row.expires_at > timezone('utc', now()) then
    return query select true, 'ok', v_row.id, v_row.expires_at, v_row.unlimited;
    return;
  end if;

  -- Already used today's trial (row exists, expired, not unlimited).
  if v_row.id is not null then
    return query select false, 'exhausted', v_row.id, v_row.expires_at, false;
    return;
  end if;

  -- First claim today.
  v_exp := timezone('utc', now()) + make_interval(mins => v_minutes);
  insert into public.demo_sessions (demo_key, visitor_key, day, expires_at, unlimited)
  values (p_demo_key, p_visitor_key, v_today, v_exp, false)
  returning * into v_row;

  return query select true, 'ok', v_row.id, v_row.expires_at, false;
end $$;

revoke all on function public.claim_demo_session(text, text, boolean) from public;
revoke execute on function public.claim_demo_session(text, text, boolean)
  from anon, authenticated;

-- ---------------------------------------------------------------- public listing view
-- DROP + CREATE (not OR REPLACE) — scar note: OR REPLACE cannot reorder/drop columns.
-- Canonical shape: has_demo instead of demo_url. Run this file last on fresh installs.

drop view if exists public.listings_with_seller;
create view public.listings_with_seller
with (security_invoker = on) as
  select l.id, l.seller_id, l.title, l.short_description, l.long_description,
         l.category, l.price_cents, l.extended_price_cents,
         l.has_demo, l.setup_instructions,
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

grant select on public.listings_with_seller to anon, authenticated;

-- Moderation queue previously selected demo_url; that would break under the revoke.
drop view if exists public.moderation_queue;
create view public.moderation_queue
with (security_invoker = on) as
  select l.id,
         l.title,
         l.status,
         l.price_cents,
         l.has_demo,
         l.created_at,
         l.updated_at,
         p.display_name          as seller_name,
         p.id                    as seller_id,
         s.status                as demo_status,
         s.consecutive_failures  as demo_failures,
         s.last_checked_at       as demo_last_checked_at,
         (select count(*) from public.purchases pu where pu.listing_id = l.id
            and pu.status = 'complete')                     as sales_count,
         (select count(*) from public.purchases pu where pu.listing_id = l.id
            and pu.status = 'refunded')                     as refund_count
  from public.listings l
  join public.profiles p on p.id = l.seller_id
  left join public.sandbox_instances s on s.listing_id = l.id;

grant select on public.moderation_queue to authenticated;
