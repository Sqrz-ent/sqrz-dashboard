-- Removes the one-simultaneous-Boost-campaign limit. Previously:
-- trg_enforce_single_active_campaign_slot (BEFORE UPDATE on boost_campaigns)
-- -> enforce_single_active_campaign_slot(): on a campaign_type='boost' row
-- transitioning status into 'in_review', raised 'SLOT_OCCUPIED' if the same
-- profile_id already had another boost-type campaign in 'in_review' or
-- 'live'. Grow-type campaigns were never subject to this (campaign_type
-- check on both sides). No other triggers touched — on_boost_campaign_hubspot_sync,
-- on_boost_campaign_submit_meta_create, on_campaign_status_notify, and
-- set_campaign_utm all remain exactly as they were.

drop trigger if exists trg_enforce_single_active_campaign_slot on boost_campaigns;
drop function if exists enforce_single_active_campaign_slot();
