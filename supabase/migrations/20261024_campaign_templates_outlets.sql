-- Display-only "outlets" field for campaign template cards (e.g. ["Instagram",
-- "Facebook"], ["TikTok"]) — shown as pills on the card cover. No backfill;
-- Will enters these manually per template.

ALTER TABLE campaign_templates
  ADD COLUMN outlets jsonb NOT NULL DEFAULT '[]';
COMMENT ON COLUMN campaign_templates.outlets IS
  'Outlets shown on the card cover, as a JSON array of labels, e.g. ["Instagram", "Facebook"]. Display only.';
