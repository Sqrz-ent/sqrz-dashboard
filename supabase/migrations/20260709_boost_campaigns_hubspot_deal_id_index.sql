-- Supports the reverse-sync lookup (HubSpot deal stage change → find the boost
-- campaign by its hubspot_deal_id). Partial: only rows that have a deal.
CREATE INDEX IF NOT EXISTS idx_boost_campaigns_hubspot_deal_id
  ON boost_campaigns (hubspot_deal_id)
  WHERE hubspot_deal_id IS NOT NULL;
