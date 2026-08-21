-- Forkable — spend cap for /api/import-repo.
-- Run after licenses_and_requests.sql. Safe to re-run.
--
-- /api/import-repo calls a paid model on every request. It requires a signed-in
-- user, but signup is free and open, so "signed in" is not a spend limit: one
-- account can loop the endpoint, and a handful of throwaway accounts can loop it
-- wider. An API key has already been drained overnight once on this project.
--
-- Two ceilings, because they fail differently:
--
--   per-user  stops one account looping it
--   global    stops N accounts each staying politely under the per-user cap,
--             which is the shape the per-user limit alone cannot see
--
-- The counter is claimed BEFORE the model call, not after. Counting completions
-- means a request that is abandoned mid-flight is free, and a loop of abandoned
-- requests is free forever.

create table if not exists public.import_usage (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  day      date not null default current_date,
  count    integer not null default 0 check (count >= 0),
  primary key (user_id, day)
);

create index if not exists import_usage_day_idx on public.import_usage (day);

alter table public.import_usage enable row level security;

-- No policy for anon/authenticated at all: this table is written by the server
-- with service_role and read by nobody else. A seller who could UPDATE their own
-- row could zero it and the cap would be decorative.
revoke all on public.import_usage from anon, authenticated;

-- Caps live in platform_settings so changing them is a row update, not a deploy —
-- same reasoning as platform_fee_bps.
alter table public.platform_settings
  add column if not exists import_daily_per_user integer not null default 5
    check (import_daily_per_user between 0 and 1000),
  add column if not exists import_daily_global   integer not null default 100
    check (import_daily_global between 0 and 100000);

-- platform_settings carries column-level select grants, and ADD COLUMN does not
-- extend them. These two are fine to be public (the UI can say "3 of 5 left"),
-- so grant them back explicitly. See the note in schema.sql about why a bare
-- `revoke select (col)` would not have worked here either.
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

-- Claim one import against both ceilings, atomically.
--
-- Atomicity is the whole point: a check-then-increment in the worker is a race,
-- and the way you exploit it is to fire fifty requests at once so they all read
-- the same pre-increment count. INSERT ... ON CONFLICT DO UPDATE takes a row
-- lock, so concurrent callers serialise on it and exactly one of them gets each
-- slot.
create or replace function public.claim_import_quota(p_user uuid)
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
  select import_daily_per_user, import_daily_global
    into v_per_user, v_global
  from public.platform_settings limit 1;

  v_per_user := coalesce(v_per_user, 5);
  v_global   := coalesce(v_global, 100);

  -- Global ceiling first: it is the backstop against many cheap accounts.
  select coalesce(sum(count), 0) into v_today
  from public.import_usage where day = current_date;

  if v_today >= v_global then
    select coalesce(count, 0) into v_used
    from public.import_usage where user_id = p_user and day = current_date;
    return query select false, 'global', coalesce(v_used, 0), v_per_user;
    return;
  end if;

  -- Per-user ceiling. The WHERE on DO UPDATE means a user already at the cap
  -- updates no row, RETURNING yields nothing, and v_used stays null — which is
  -- how "denied" is signalled without a second read racing the first.
  insert into public.import_usage (user_id, day, count)
  values (p_user, current_date, 1)
  on conflict (user_id, day) do update
     set count = public.import_usage.count + 1
   where public.import_usage.count < v_per_user
  returning count into v_used;

  if v_used is null then
    return query select false, 'per_user', v_per_user, v_per_user;
    return;
  end if;

  return query select true, null::text, v_used, v_per_user;
end $$;

-- Only the server may claim quota. Leaving this callable by `authenticated`
-- would let a seller burn their own quota to nothing from the browser, or worse,
-- discover the shape of the limit by probing it.
revoke execute on function public.claim_import_quota(uuid) from anon, authenticated, public;

-- Housekeeping: yesterday's rows are not interesting once the day rolls over.
-- Left as a manual statement rather than a cron — there is no scheduler for it
-- yet and the table is tiny.
--   delete from public.import_usage where day < current_date - 30;
