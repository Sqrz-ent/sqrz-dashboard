-- Add 'rejected' (final decline, manual refund) alongside the existing Boost
-- statuses. Distinct from 'needs_changes' (fixable/resubmit). Grow stays free.
ALTER TABLE boost_campaigns DROP CONSTRAINT boost_campaigns_status_check;
ALTER TABLE boost_campaigns ADD CONSTRAINT boost_campaigns_status_check
  CHECK (
    (campaign_type = 'boost' AND status = ANY (ARRAY['booked'::text,'in_review'::text,'needs_changes'::text,'approved'::text,'live'::text,'completed'::text,'rejected'::text]))
    OR campaign_type <> 'boost'
  );
