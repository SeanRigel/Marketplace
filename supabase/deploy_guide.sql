-- Forkable — post-purchase AI deploy walkthrough.
-- Run AFTER security_hardening.sql. Safe to re-run.
--
-- Buyers get a generated "how to deploy this" guide on the Purchases page.
-- The model call costs money, so this file:
--
--   1. Caps generations per user and across the site (same shape as import_quota)
--   2. Caches the result per listing + host so the second buyer is free
--
-- The Pages Function /api/deploy-guide is the only writer. Do not grant these
-- tables to anon/authenticated.

-- ---------------------------------------------------------------- settings
alter table public.platform_settings
  add column if not exists deploy_guide_daily_per_user integer not null default 8
    check (deploy_guide_daily_per_user between 0 and 1000),
  add column if not exists deploy_guide_daily_global   integer not null default 150
    check (deploy_guide_daily_global between 0 and 100000);

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

-- ---------------------------------------------------------------- usage
create table if not exists public.deploy_guide_usage (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  day      date not null default current_date,
  count    integer not null default 0 check (count >= 0),
  primary key (user_id, day)
);

create index if not exists deploy_guide_usage_day_idx
  on public.deploy_guide_usage (day);

alter table public.deploy_guide_usage enable row level security;
revoke all on public.deploy_guide_usage from anon, authenticated;

-- ---------------------------------------------------------------- cache
create table if not exists public.deploy_guides (
  listing_id          uuid not null references public.listings(id) on delete cascade,
  host                text not null check (host in ('cloudflare', 'vercel', 'other')),
  listing_updated_at  timestamptz not null,
  guide               jsonb not null,
  created_at          timestamptz not null default now(),
  primary key (listing_id, host)
);

alter table public.deploy_guides enable row level security;
revoke all on public.deploy_guides from anon, authenticated;

create or replace function public.claim_deploy_guide_quota(p_user uuid)
returns table (allowed boolean, reason text, used integer, per_user_limit integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_per_user integer;
  v_global   integer;
  v_used     integer;
  v_today    integer;
begin
  if p_user is null then
    return query select false, 'invalid', 0, 0;
    return;
  end if;

  select deploy_guide_daily_per_user, deploy_guide_daily_global
    into v_per_user, v_global
  from public.platform_settings limit 1;

  v_per_user := coalesce(v_per_user, 8);
  v_global   := coalesce(v_global, 150);

  select coalesce(sum(count), 0) into v_today
  from public.deploy_guide_usage where day = current_date;

  if v_today >= v_global then
    select coalesce(count, 0) into v_used
    from public.deploy_guide_usage where user_id = p_user and day = current_date;
    return query select false, 'global', coalesce(v_used, 0), v_per_user;
    return;
  end if;

  insert into public.deploy_guide_usage (user_id, day, count)
  values (p_user, current_date, 1)
  on conflict (user_id, day) do update
     set count = public.deploy_guide_usage.count + 1
   where public.deploy_guide_usage.count < v_per_user
  returning count into v_used;

  if v_used is null then
    return query select false, 'per_user', v_per_user, v_per_user;
    return;
  end if;

  return query select true, null::text, v_used, v_per_user;
end $$;

revoke all on function public.claim_deploy_guide_quota(uuid) from public;
revoke execute on function public.claim_deploy_guide_quota(uuid)
  from anon, authenticated;
