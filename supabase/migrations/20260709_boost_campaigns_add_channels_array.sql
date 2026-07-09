-- Multi-channel support: boost stays single ('meta'), grow can select a subset
-- of ['meta','google']. Backfilled from the legacy single `channel` column,
-- which is kept for now (readers migrated separately) but no longer written.
ALTER TABLE boost_campaigns ADD COLUMN channels text[];
UPDATE boost_campaigns SET channels = ARRAY[channel] WHERE channel IS NOT NULL;
ALTER TABLE boost_campaigns ADD CONSTRAINT boost_campaigns_channels_check CHECK (
  (campaign_type = 'boost' AND channels = ARRAY['meta']) OR
  (campaign_type = 'grow' AND channels <@ ARRAY['meta','google']::text[] AND array_length(channels,1) >= 1) OR
  campaign_type NOT IN ('boost','grow')
);
