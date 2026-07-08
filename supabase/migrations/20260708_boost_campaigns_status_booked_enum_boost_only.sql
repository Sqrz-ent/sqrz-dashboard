-- Boost-only status lifecycle. Grow rows stay unconstrained (manual, outside
-- this flow). New Boost set: booked, in_review, needs_changes, approved, live,
-- completed. 'booked' = paid, no content yet; 'in_review' = content submitted.
--
-- Supersedes the flat status constraint from the earlier Phase-1 migration:
-- booking (payment + goal/budget) and content creation (creative/targeting/
-- notes) are now two separate steps, so draft/submitted collapse into 'booked'.
ALTER TABLE boost_campaigns DROP CONSTRAINT boost_campaigns_status_check;

-- Restore the Grow row swept to 'submitted' by the Phase-1 migration
-- (its real pre-flow state was 'pending'). Grow must not be touched by this work.
UPDATE boost_campaigns SET status = 'pending'
  WHERE campaign_type <> 'boost' AND status = 'submitted';

-- Boost pre-content rows (submitted/draft) -> booked.
UPDATE boost_campaigns SET status = 'booked'
  WHERE campaign_type = 'boost' AND status IN ('submitted', 'draft');

ALTER TABLE boost_campaigns ADD CONSTRAINT boost_campaigns_status_check
  CHECK (
    (campaign_type = 'boost' AND status = ANY (ARRAY['booked'::text,'in_review'::text,'needs_changes'::text,'approved'::text,'live'::text,'completed'::text]))
    OR campaign_type <> 'boost'
  );
