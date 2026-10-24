-- Meta Lead Ads: schema only, no data writes, no RLS changes.

-- 1) leads — new columns + widened source check
ALTER TABLE leads ADD COLUMN meta_lead_id text UNIQUE;
ALTER TABLE leads ADD COLUMN meta_form_id text;
ALTER TABLE leads ADD COLUMN answers jsonb;

ALTER TABLE leads DROP CONSTRAINT leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check
  CHECK (source = ANY (ARRAY['web_form', 'chat', 'meta_lead_ads']));

-- 2) boost_campaigns — per-campaign lead form id
ALTER TABLE boost_campaigns ADD COLUMN meta_leadgen_form_id text;
COMMENT ON COLUMN boost_campaigns.meta_leadgen_form_id IS
  'Meta lead form id created for this campaign; reused if set (idempotent like meta_campaign_id).';

-- 3) campaign_templates — lead_form creative source + its config
ALTER TABLE campaign_templates DROP CONSTRAINT campaign_templates_creative_source_check;
ALTER TABLE campaign_templates ADD CONSTRAINT campaign_templates_creative_source_check
  CHECK (creative_source = ANY (ARRAY['upload', 'existing_post', 'lead_form']));

ALTER TABLE campaign_templates ADD COLUMN lead_form_config jsonb;
COMMENT ON COLUMN campaign_templates.lead_form_config IS
  'Meta instant-form config for lead_form templates, mirroring POST /{page_id}/leadgen_forms: { "name": text, "locale": text, "privacy_policy": { "url": text, "link_text": text }, "questions": [ { "type": "FULL_NAME"|"EMAIL"|"PHONE"|"CUSTOM", "key": text, "label": text, "options": [ { "key": text, "value": text } ] } ], "thank_you_page": { "title": text, "body": text, "button_type": "VIEW_WEBSITE", "button_text": text, "website_url": text } }. Edited by Will by hand (Airtable/Supabase); no app ever writes it.';
