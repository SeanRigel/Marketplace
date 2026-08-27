-- Forkable — moderation.
-- Run after import_quota.sql. Safe to re-run.
--
-- Until now nobody could take anything down. A seller sets their own listing to
-- 'live'; `pending_review` exists in the status enum but nothing consumes it.
-- That is fine while all three listings are ours. The first time a stranger
-- lists something -- malware, someone else's code, a demo that is a signup wall
-- -- the only available response was to edit the database by hand.
--
-- SECURITY SHAPE, and why it is not the obvious one.
--
-- The obvious implementation is an RLS policy like
--     create policy "admins update any listing" on public.listings
--       for update using (is_admin());
-- which works, and hands any admin the ability to rewrite every field of every
-- seller's listing -- title, price, repo_url. That is far more authority than
-- moderation needs, and RLS is row-level so it cannot be narrowed to one column.
--
-- Instead there is no admin UPDATE policy at all. Status changes go through a
-- security-definer function that can only ever write `status`. An admin can take
-- something down; an admin cannot quietly change what a listing costs or where
-- its repository points.

-- ---------------------------------------------------------------- the flag
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- Never client-writable. A seller who could set this on themselves would own the
-- marketplace. Same reasoning as stripe_connect_id, and the same trap: a bare
-- `revoke update (col)` is fine for writes, but the SELECT side needs the
-- table-grant dance described at length in schema.sql.
revoke update (is_admin) on public.profiles from anon, authenticated;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name not in ('stripe_connect_id', 'stripe_charges_enabled',
                            'stripe_payouts_enabled', 'stripe_details_submitted',
                            'is_admin');
  execute 'revoke select on public.profiles from anon, authenticated';
  execute format('grant select (%s) on public.profiles to anon, authenticated', cols);
end $$;

-- ---------------------------------------------------------------- am I an admin?
-- security definer so it can read is_admin, which the caller cannot select.
-- Callable by signed-in users: the app needs to know whether to render the admin
-- link, and the answer for a non-admin is simply false.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

revoke execute on function public.is_admin() from anon;

-- ---------------------------------------------------------------- see everything
-- Moderation is impossible if you cannot see what you are moderating. Admins can
-- read every listing regardless of status; everyone else keeps the original rule.
drop policy if exists "live listings are public" on public.listings;
create policy "live listings are public"
  on public.listings for select
  using (status = 'live' or seller_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------- the one action
-- Writes `status` and nothing else. There is deliberately no admin UPDATE policy
-- on listings, so this function is the entire surface of admin authority over
-- someone else's listing.
create or replace function public.admin_set_listing_status(
  p_listing uuid,
  p_status  listing_status,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;

  update public.listings set status = p_status where id = p_listing;

  if not found then
    raise exception 'Listing not found.' using errcode = 'P0002';
  end if;

  insert into public.moderation_log (listing_id, actor_id, new_status, reason)
  values (p_listing, auth.uid(), p_status, nullif(btrim(coalesce(p_reason, '')), ''));
end $$;

revoke execute on function public.admin_set_listing_status(uuid, listing_status, text) from anon;

-- ---------------------------------------------------------------- the record
-- Every takedown is written down. Partly so a seller asking "why was I removed?"
-- gets a real answer, and partly because with more than one person holding admin
-- the question "who did this" needs an answer that is not memory.
create table if not exists public.moderation_log (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  new_status  listing_status not null,
  reason      text,
  created_at  timestamptz not null default now()
);

create index if not exists moderation_log_listing_idx
  on public.moderation_log (listing_id, created_at desc);

alter table public.moderation_log enable row level security;

-- Readable by admins only. It names who did what, which is not public business.
drop policy if exists "admins read moderation log" on public.moderation_log;
create policy "admins read moderation log"
  on public.moderation_log for select
  to authenticated
  using (public.is_admin());

-- No insert/update/delete policy: rows come only from the function above, which
-- runs as definer. An admin cannot edit the record of what they did.
revoke insert, update, delete on public.moderation_log from anon, authenticated;

-- ---------------------------------------------------------------- the queue
-- What a moderator actually opens: everything awaiting review or recently
-- changed, with enough context to judge without clicking into each one.
create or replace view public.moderation_queue
with (security_invoker = on) as
  select l.id,
         l.title,
         l.status,
         l.price_cents,
         l.demo_url,
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

-- security_invoker means this view is only as visible as the listings policy
-- above allows -- so a non-admin querying it sees live listings and their own,
-- exactly as everywhere else. The view grants nothing on its own.

-- ---------------------------------------------------------------- making yourself an admin
-- Deliberately not automated: there is no "first user becomes admin" rule,
-- because that is a race worth losing to a stranger who signs up before you do.
-- Run this by hand, once, with your own email:
--
--   update public.profiles set is_admin = true
--   where id = (select id from auth.users where email = 'you@example.com');
--
-- And to check it took:
--
--   select p.is_admin, u.email from public.profiles p
--   join auth.users u on u.id = p.id where p.is_admin;
