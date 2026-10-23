-- on_boost_campaign_hubspot_sync's column-watch list needs campaign_template
-- added now that it (not goal) is the real source of truth for a campaign's
-- template — without this, changing ONLY campaign_template on a row
-- (e.g. a future admin correction) would never re-fire the sync, even
-- though hubspot-sync-deal's dealname composition now reads it (see the
-- same-day edge function change).
--
-- No CREATE OR REPLACE TRIGGER for a column list (Postgres has no ALTER
-- TRIGGER for this) — drop + recreate, identical definition otherwise.
drop trigger if exists on_boost_campaign_hubspot_sync on boost_campaigns;

create trigger on_boost_campaign_hubspot_sync
  after insert or update of name, status, budget_currency, campaign_type, campaign_template, goal, channels, channel, target_audience, notes, creative_asset_url, starts_at, ends_at
  on boost_campaigns
  for each row execute function trigger_hubspot_sync_deal();
