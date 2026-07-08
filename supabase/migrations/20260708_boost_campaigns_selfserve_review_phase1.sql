-- Phase 1 self-serve Boost intake + hand-held review workflow.
ALTER TABLE boost_campaigns ADD COLUMN IF NOT EXISTS review_feedback text;
ALTER TABLE boost_campaigns ADD COLUMN IF NOT EXISTS creative_asset_url text;
ALTER TABLE boost_campaigns ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;

-- Normalise free-text channel values before constraining
-- (e.g. "Meta (Facebook + Instagram)" -> 'meta').
UPDATE boost_campaigns SET channel = 'meta' WHERE channel IS NOT NULL;

ALTER TABLE boost_campaigns ADD CONSTRAINT boost_campaigns_channel_check
  CHECK (channel IS NULL OR channel = ANY (ARRAY['meta'::text]));

-- Drop the old status constraint FIRST so the status migration UPDATEs are
-- allowed, then normalise legacy statuses, then apply the new lifecycle check.
-- Old constraint allowed: pending, preparing, live, completed, cancelled.
ALTER TABLE boost_campaigns DROP CONSTRAINT boost_campaigns_status_check;

-- Existing rows are 'pending' (awaiting the team) -> 'submitted'.
UPDATE boost_campaigns SET status = 'submitted'
  WHERE status IN ('pending', 'preparing', 'pending_payment');
-- Defensive: anything else not in the new set (e.g. 'cancelled') -> 'draft'.
UPDATE boost_campaigns SET status = 'draft'
  WHERE status IS NOT NULL
    AND status NOT IN ('draft','submitted','in_review','needs_changes','approved','live','completed');

ALTER TABLE boost_campaigns ADD CONSTRAINT boost_campaigns_status_check
  CHECK (status = ANY (ARRAY['draft'::text,'submitted'::text,'in_review'::text,'needs_changes'::text,'approved'::text,'live'::text,'completed'::text]));
