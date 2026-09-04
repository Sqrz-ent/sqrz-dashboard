-- Queue of paid "fast-track this city" fetch requests from venuefindr-ios.
-- Purely a queue record written by the client after a successful consumable
-- IAP; a future backend piece reads pending rows (service role), runs Outscraper
-- for the city at the requested tier, and flips status. No client reads.
--
-- Applied to the live shared project (fmjefvdtnmgdfauedpmg) via MCP on
-- 2026-09-04; committed here so the shared-DB change is tracked in-repo (the
-- venuefindr-ios repo has no migrations dir — shared-DB DDL lives here).
create table if not exists public.city_fetch_requests (
  id             bigint generated always as identity primary key,
  city_name      text not null,
  country_hint   text,
  tier           text not null check (tier in ('quick_fetch', 'full_fetch', 'full_fetch_contacts')),
  rc_transaction_id text,   -- RevenueCat/StoreKit transaction id (payment ref)
  rc_app_user_id    text,   -- RevenueCat app user id (who paid)
  status         text not null default 'pending',
  created_at     timestamptz not null default now()
);

alter table public.city_fetch_requests enable row level security;

-- Client (anon key) may only INSERT — same shape as city_requests' policy.
-- No SELECT/UPDATE/DELETE for the client; the backend uses the service role
-- (which bypasses RLS) to read the queue and update status.
create policy "Anon can queue city fetches"
  on public.city_fetch_requests
  for insert
  with check (true);
