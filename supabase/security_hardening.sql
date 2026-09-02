-- Forkable — extra locks for public write paths.
-- Run AFTER demo_gate.sql. Safe to re-run.
--
-- 1. Waitlist inserts only from the server (service_role). The browser used to
--    write with the anon key, which is public in config.js — anyone could flood
--    the table. /api/waitlist is now the only writer.
-- 2. claim_rate_limit: atomic per-bucket per-key counters used by Functions.

drop policy if exists "anon can join waitlist" on public.waitlist;
revoke insert, update, delete, select on public.waitlist from anon, authenticated;

create table if not exists public.rate_limit_hits (
  bucket     text not null,
  key        text not null,
  window_start timestamptz not null,
  count      integer not null default 0 check (count >= 0),
  primary key (bucket, key, window_start)
);

create index if not exists rate_limit_hits_window_idx
  on public.rate_limit_hits (window_start);

alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated;

create or replace function public.claim_rate_limit(
  p_bucket          text,
  p_key             text,
  p_limit           integer,
  p_window_seconds  integer
)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_used  integer;
  v_limit integer := greatest(1, least(coalesce(p_limit, 1), 100000));
  v_win   integer := greatest(10, least(coalesce(p_window_seconds, 3600), 86400));
begin
  if p_bucket is null or length(trim(p_bucket)) = 0
     or p_key is null or length(trim(p_key)) = 0 then
    return query select false, 0;
    return;
  end if;

  -- Truncate to the window so concurrent claims share one row.
  v_start := to_timestamp(floor(extract(epoch from timezone('utc', now())) / v_win) * v_win);

  insert into public.rate_limit_hits (bucket, key, window_start, count)
  values (trim(p_bucket), trim(p_key), v_start, 1)
  on conflict (bucket, key, window_start) do update
     set count = public.rate_limit_hits.count + 1
   where public.rate_limit_hits.count < v_limit
  returning count into v_used;

  if v_used is null then
    return query select false, v_limit;
    return;
  end if;

  return query select true, v_used;
end $$;

revoke all on function public.claim_rate_limit(text, text, integer, integer) from public;
revoke execute on function public.claim_rate_limit(text, text, integer, integer)
  from anon, authenticated;

-- ---------------------------------------------------------------- profiles writes
-- A column-level REVOKE UPDATE is a silent no-op under a table-level UPDATE
-- grant (same trap as SELECT, documented in schema.sql). Any signed-in user
-- could PATCH is_admin=true or spoof stripe_charges_enabled. Drop the table
-- grant and give back only the fields the profile form actually edits.

do $$
begin
  execute 'revoke update on public.profiles from anon, authenticated';
  execute 'grant update (display_name, bio, role) on public.profiles to authenticated';
end $$;

-- ---------------------------------------------------------------- sandbox_instances
-- demo_gate hid listings.demo_url, then the health checker stored the same URL
-- on sandbox_instances.url with a public SELECT policy. Hide url + last_error.

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sandbox_instances'
    and column_name not in ('url', 'last_error');
  if cols is null then
    return;
  end if;
  execute 'revoke select on public.sandbox_instances from anon, authenticated';
  execute format('grant select (%s) on public.sandbox_instances to anon, authenticated', cols);
end $$;
