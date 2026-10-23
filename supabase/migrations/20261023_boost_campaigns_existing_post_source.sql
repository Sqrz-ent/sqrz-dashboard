-- Disambiguates which platform existing_post_id refers to (2026-10-23,
-- Instagram posts added to the existing-post picker). NULL = facebook, for
-- back-compat with every existing_post_id value written before this column
-- existed (all Facebook-only at the time). Read by meta-campaign-create to
-- decide between object_story_id (facebook) and source_instagram_media_id +
-- instagram_user_id (instagram) when building the ad creative.
ALTER TABLE boost_campaigns ADD COLUMN existing_post_source text
  CHECK (existing_post_source IN ('facebook', 'instagram') OR existing_post_source IS NULL);
