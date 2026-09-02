-- Forkable — agent teams + trading bots as listing categories.
-- Run AFTER deploy_guide.sql. Safe to re-run (IF NOT EXISTS).
--
-- Postgres enums cannot be updated with a plain CHECK swap. ADD VALUE is the
-- documented way. Buyers/sellers pick these in the listing form and browse
-- filters; existing rows are unchanged.

alter type public.listing_category add value if not exists 'ai_agents';
alter type public.listing_category add value if not exists 'trading_bots';
