-- Grow is fully manual — only Boost campaigns should sync as HubSpot deals.
-- Recreate the trigger with a WHEN guard so Grow rows never call the deal fn.
DROP TRIGGER IF EXISTS on_boost_campaign_hubspot_sync ON boost_campaigns;

CREATE TRIGGER on_boost_campaign_hubspot_sync
  AFTER INSERT OR UPDATE ON boost_campaigns
  FOR EACH ROW
  WHEN (NEW.campaign_type = 'boost')
  EXECUTE FUNCTION trigger_hubspot_sync_deal();
