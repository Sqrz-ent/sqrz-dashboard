-- Unify Grow into the HubSpot deal sync: both Boost and Grow campaigns sync as
-- deals in the same "Boost Campaigns" pipeline. Remove the Boost-only WHEN guard.
-- (The function still only syncs statuses that map to a stage — booked onward.)
DROP TRIGGER IF EXISTS on_boost_campaign_hubspot_sync ON boost_campaigns;

CREATE TRIGGER on_boost_campaign_hubspot_sync
  AFTER INSERT OR UPDATE ON boost_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION trigger_hubspot_sync_deal();
