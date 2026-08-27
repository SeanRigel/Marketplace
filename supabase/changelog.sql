-- Forkable — listing changelog.
-- Run after reviews_and_health.sql. Safe to re-run.
--
-- Reusable software is not a static download. A seller fixes a bug, bumps a
-- dependency, adds a webhook handler — and today nobody who already bought it has
-- any way to know. This is the record of that, and it does double duty: it tells a
-- buyer the template is maintained *before* they buy, and tells them what changed
-- *after*.

create table if not exists public.listing_updates (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings(id) on delete cascade,
  version     text,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists listing_updates_listing_idx
  on public.listing_updates (listing_id, created_at desc);

alter table public.listing_updates enable row level security;

-- Visible wherever the listing itself is visible. Mirrors the listings select policy
-- rather than inventing a second rule that could drift from it.
drop policy if exists "updates follow listing visibility" on public.listing_updates;
create policy "updates follow listing visibility"
  on public.listing_updates for select
  using (exists (
    select 1 from public.listings l
    where l.id = listing_id and (l.status = 'live' or l.seller_id = auth.uid())
  ));

drop policy if exists "sellers write own updates" on public.listing_updates;
create policy "sellers write own updates"
  on public.listing_updates for insert to authenticated
  with check (exists (
    select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid()
  ));

drop policy if exists "sellers edit own updates" on public.listing_updates;
create policy "sellers edit own updates"
  on public.listing_updates for update to authenticated
  using (exists (
    select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid()
  ));

drop policy if exists "sellers delete own updates" on public.listing_updates;
create policy "sellers delete own updates"
  on public.listing_updates for delete to authenticated
  using (exists (
    select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid()
  ));

-- "Last updated" as a signal of maintenance, for the browse card.
create or replace view public.listing_update_summary
with (security_invoker = on) as
  select listing_id,
         count(*)                          as update_count,
         max(created_at)                   as last_update_at,
         (array_agg(version order by created_at desc)
            filter (where version is not null))[1] as latest_version
  from public.listing_updates
  group by listing_id;
