-- Campaigns are defined ONLY by their template now — goal is deprecated and
-- must not drive any decision going forward. An audit (2026-10-24) found
-- goal (and campaign_type/channels, derived from it in one undocumented
-- place or another) being used as a proxy for "which template" throughout
-- BoostContentSheet, CampaignActivationProducts, meta-campaign-create,
-- verify-campaign-activation, apple-consumable-webhook, the HubSpot sync,
-- and both AI advisors — with nothing enforcing goal and template stay 1:1.
-- campaign_template becomes the real source of truth; goal is kept, for
-- legacy rows only, never written again by any new campaign.
--
-- campaign_template itself already existed on boost_campaigns (confirmed
-- live, undocumented — no migration file, no column comment, zero readers
-- or writers anywhere in either repo, all 3 existing rows NULL). This
-- migration is the first thing that actually constrains and documents it,
-- not the thing that created it.

alter table boost_campaigns
  add constraint boost_campaigns_campaign_template_check
  check (campaign_template in ('template_01', 'template_02', 'custom') or campaign_template is null);

comment on column boost_campaigns.campaign_template is
  'Source of truth for which creation template this campaign came from. '
  'template_01 = Awareness (existing Instagram post + fixed Learn More CTA), '
  'template_02 = Traffic (new creative upload), '
  'custom = Large Boost/Managed (talk to SQRZ — no self-serve row is ever '
  'created for this one). NULL = legacy campaign, created before this '
  'column existed (or any future row a client fails to set it on) — every '
  'reader must treat NULL as "fall back to the old goal-based upload-flow '
  'behavior", never guess a template. goal is deprecated as of 2026-10-24: '
  'still present and still written for backward-compatible reads of '
  'existing NULL-campaign_template rows, but must not gate any new '
  'decision in application code.';

-- Re-key campaign_activation_products by template_id instead of goal — the
-- IAP product a campaign activates is a property of its TEMPLATE, not an
-- incidental goal string two templates happen to share today. goal is kept
-- as a plain (now unused-for-lookup) column, same "deprecated, not dropped"
-- treatment as boost_campaigns.goal above. Confirmed before changing the PK:
-- zero rows in campaign_activations (the one table that could theoretically
-- FK or join against this), and no FK anywhere references this table at all
-- — safe to swap the primary key with no data-migration risk.
alter table campaign_activation_products add column template_id text;

update campaign_activation_products set template_id = case goal
  when 'visibility' then 'template_01'
  when 'bookings' then 'template_02'
  else null
end;

alter table campaign_activation_products alter column template_id set not null;
alter table campaign_activation_products
  add constraint campaign_activation_products_template_id_check
  check (template_id in ('template_01', 'template_02'));

alter table campaign_activation_products drop constraint campaign_activation_products_pkey;
alter table campaign_activation_products add primary key (template_id);
-- goal was the old PK (implicitly unique) — preserve that uniqueness even
-- though it's no longer the lookup key, so the deprecated column can't
-- silently end up with duplicate values either.
alter table campaign_activation_products add constraint campaign_activation_products_goal_key unique (goal);

comment on column campaign_activation_products.template_id is
  'Source of truth for this row''s lookup key (2026-10-24) — replaces goal. '
  'verify-campaign-activation and apple-consumable-webhook resolve the '
  'expected/matching product by template_id now, never by goal.';
comment on column campaign_activation_products.goal is
  'Deprecated 2026-10-24, superseded by template_id. Kept only because '
  'dropping columns is out of scope for this pass — not read by any '
  'application code anymore.';
