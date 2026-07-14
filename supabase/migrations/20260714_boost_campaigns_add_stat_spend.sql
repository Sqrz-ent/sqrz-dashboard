-- Actual ad spend to date for a boost/grow campaign, entered manually.
-- No Meta API access yet, so this follows the same manual-entry workflow already
-- used for the other stat_* columns. There is deliberately no landing-page-views
-- column here — stat_profile_visits already serves that purpose (labeled
-- "Landing page views" in the campaign Analytics UI).
ALTER TABLE public.boost_campaigns
  ADD COLUMN IF NOT EXISTS stat_spend numeric;

COMMENT ON COLUMN public.boost_campaigns.stat_spend IS
  'Actual ad spend to date, entered manually (no Meta API access yet). Currency is assumed to match budget_currency on the same row.';
