-- Replaces the duration-pills create-sheet UI with an explicit end choice
-- (2026-10-22): a fixed end date/time, or "run until the allocated budget
-- is used up" (a daily pacing rate instead of a fixed end). Start is always
-- "now" — starts_at is untouched (still a plain date, still set to today at
-- creation).
--
-- end_mode is nullable and existing rows are left NULL deliberately —
-- "existing campaigns keep working unchanged (treat them as before)".
-- meta-campaign-create/meta-adset-budget-sync both treat NULL exactly like
-- the pre-existing 'date'-shaped behavior (ends_at + the lifetime_budget
-- floor), since that's what every row before this migration already is.
alter table boost_campaigns
  add column end_mode text check (end_mode in ('date', 'budget')),
  add column daily_budget_cents bigint;

comment on column boost_campaigns.end_mode is 'NULL = legacy (same as "date"), ''date'' = fixed end_time (ends_at) + lifetime_budget floor as before, ''budget'' = daily_budget pacing, no end_time, stopped by meta-insights-sync once stat_spend reaches the allocated budget.';
comment on column boost_campaigns.daily_budget_cents is 'Only meaningful when end_mode=''budget'' — the ad set''s daily_budget on Meta, in cents.';

-- ends_at becomes a real timestamp (date + time, device-local at input,
-- stored as the usual UTC instant) instead of a bare date — needed for the
-- new "On a date" end choice's time component. Existing rows cast cleanly:
-- a DATE casts to TIMESTAMPTZ at midnight UTC, which is exactly the same
-- instant every existing reader (new Date(c.ends_at) in the edge functions)
-- already interpreted a bare "YYYY-MM-DD" string as — no behavior change
-- for any pre-existing row.
--
-- on_boost_campaign_hubspot_sync's column list depends on ends_at's type,
-- so Postgres blocks the ALTER while it exists — drop and recreate with the
-- IDENTICAL definition (column list is by name, not type, so this is a
-- no-op for the trigger's own behavior).
drop trigger on_boost_campaign_hubspot_sync on boost_campaigns;

alter table boost_campaigns
  alter column ends_at type timestamptz using ends_at::timestamptz;

create trigger on_boost_campaign_hubspot_sync
  after insert or update of name, status, budget_currency, campaign_type, goal, channels, channel, target_audience, notes, creative_asset_url, starts_at, ends_at
  on boost_campaigns
  for each row execute function trigger_hubspot_sync_deal();
