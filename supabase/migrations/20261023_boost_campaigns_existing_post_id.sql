-- Promote an existing Facebook post instead of uploading new creative
-- (2026-10-23). Nullable, no default — NULL means "upload new creative",
-- the unchanged existing behavior. Set by the iOS create-campaign sheet
-- when the artist picks a post from meta-page-posts (Facebook posts only,
-- no Instagram yet); read by meta-campaign-create to decide whether to
-- build the ad creative's object_story_id from this post instead of a new
-- object_story_spec.
ALTER TABLE boost_campaigns ADD COLUMN existing_post_id text;
