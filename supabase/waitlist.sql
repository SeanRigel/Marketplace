-- Forkable — step 0 waitlist table.
-- Run in the Supabase SQL editor, then put the project URL + ANON key in config.js.
-- The anon key is public by design; the service_role key must never touch client code.

create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  role        text not null default 'both' check (role in ('buyer', 'seller', 'both')),
  note        text,
  created_at  timestamptz not null default now()
);

-- One signup per address; the landing page treats the resulting 409 as "already on the list".
create unique index if not exists waitlist_email_key
  on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

-- Anonymous visitors may insert their own signup and nothing else.
-- There is deliberately no select/update/delete policy, so the anon key cannot
-- read the list back out. Read it from the Supabase dashboard.
drop policy if exists "anon can join waitlist" on public.waitlist;
create policy "anon can join waitlist"
  on public.waitlist for insert
  to anon
  with check (true);
