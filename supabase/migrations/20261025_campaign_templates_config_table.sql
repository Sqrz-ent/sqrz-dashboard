-- campaign_templates — pure configuration for Boost/Grow campaign templates
-- (2026-10-25). Will edits these rows directly (Table Editor today, possibly
-- synced from Airtable later). The app and backend read ONLY this table's
-- columns to decide template behavior from here on — no template id, name,
-- price, or behavior should ever be hardcoded in application code again.
-- No rows are seeded by this migration; Will fills them in (see this
-- migration's own PR/report for the exact columns needed for the two
-- existing test campaigns' templates, 'template_01' and 'template_02').
create table campaign_templates (
  id text primary key,
  name text not null,
  subtitle text,
  description text,
  image_file text,
  display_price numeric,
  iap_product_id text,
  creative_source text not null check (creative_source in ('upload', 'existing_post')),
  post_source text check (post_source in ('instagram', 'facebook') or post_source is null),
  cta_type text,
  allow_destination_choice boolean not null default false,
  budget_options integer[] not null default '{}',
  ad_budget_min integer,
  ad_budget_max integer,
  end_options text[] not null default '{}',
  meta_objective text,
  access_tier text not null default 'free' check (access_tier in ('free', 'premium')),
  requires_connected_page boolean not null default false,
  requires_eligibility_check boolean not null default false,
  delivery text not null default 'self_serve' check (delivery in ('self_serve', 'contact')),
  status text not null default 'active' check (status in ('active', 'coming_soon', 'hidden')),
  sort_order integer not null default 0,
  available_from timestamptz,
  available_until timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table campaign_templates is
  'Pure configuration for Boost/Grow campaign templates. Edited directly by '
  'Will (Table Editor, possibly Airtable-synced later) — no client ever '
  'writes to this table. boost_campaigns.campaign_template is a foreign key '
  'into this table''s id. See the column comments for what each field '
  'controls before editing.';

comment on column campaign_templates.id is
  'Primary key, e.g. ''T01''. Referenced by boost_campaigns.campaign_template '
  '(ON UPDATE CASCADE — renaming an id here automatically updates every '
  'campaign that points at it, so renaming is safe). Never delete a row '
  'that existing campaigns still reference (the FK blocks it).';
comment on column campaign_templates.name is
  'Display name shown on the Grow tab template card, and used as the legacy '
  'fallback label (e.g. in HubSpot deal names) for a campaign whose own '
  'name is blank.';
comment on column campaign_templates.subtitle is
  'One-line subtitle shown under the name on the template card.';
comment on column campaign_templates.description is
  'Longer explanation line shown on the (unlocked) template card.';
comment on column campaign_templates.image_file is
  'Storage object path in the public_images bucket, used as the card''s '
  'background image. Leave null to fall back to the plain gradient '
  'background.';
comment on column campaign_templates.display_price is
  'Fallback price shown on the card when iap_product_id is null, or the '
  'real App Store product fails to load. Purely cosmetic — the artist is '
  'only ever actually charged via the real StoreKit product (iap_product_id); '
  'this number is never itself charged.';
comment on column campaign_templates.iap_product_id is
  'App Store Connect consumable product id charged at campaign activation '
  '(e.g. ''com.sqrz.ios.activation.template_01''). Null = this template has '
  'no activation charge at all (e.g. a delivery=''contact'' template, which '
  'never goes through the in-app purchase flow).';
comment on column campaign_templates.creative_source is
  '''upload'' = the artist uploads new creative; ''existing_post'' = the '
  'artist picks one of their connected Page''s existing posts instead. '
  'Drives which step the create/content sheets show.';
comment on column campaign_templates.post_source is
  'Only meaningful when creative_source=''existing_post''. ''instagram'' or '
  '''facebook'' — which platform''s posts the existing-post picker offers. '
  'Null when creative_source=''upload''.';
comment on column campaign_templates.cta_type is
  'Fixed call-to-action button type for an existing_post creative (e.g. '
  '''LEARN_MORE''), only used when creative_source=''existing_post'' AND '
  'post_source=''instagram'' — Meta''s object_story_id (Facebook existing-post) '
  'path cannot override the button at all regardless of this value. Null '
  'for ''upload'' templates, whose CTA is instead chosen per-campaign by the '
  'artist (boost_campaigns.cta_type, a different column — the artist''s own '
  'choice, not this template default).';
comment on column campaign_templates.allow_destination_choice is
  'Whether the artist picks a destination (their profile vs. a private '
  'link) for this template''s ad. Meaningful mainly for existing_post '
  'templates with a fixed cta_type, whose CTA needs somewhere to link to; '
  'an ''upload'' template''s destination is typically implicit in what was '
  'uploaded.';
comment on column campaign_templates.budget_options is
  'Preset dollar amounts shown as pills on this template''s ad-budget '
  'picker, e.g. {50,75,100,150,200}.';
comment on column campaign_templates.ad_budget_min is
  'Display-only minimum for the budget range shown on the card (e.g. the '
  '''$50'' in ''$50 – $200''). Not enforced server-side — budget_options is '
  'what the picker actually offers; this is cosmetic.';
comment on column campaign_templates.ad_budget_max is
  'Display-only maximum for the budget range shown on the card (e.g. the '
  '''$200'' in ''$50 – $200''). Not enforced server-side — budget_options is '
  'what the picker actually offers; this is cosmetic.';
comment on column campaign_templates.end_options is
  'Which campaign-end choices this template offers, e.g. {''budget'',''date''}. '
  'Values match boost_campaigns.end_mode.';
comment on column campaign_templates.meta_objective is
  'Meta campaign objective (ODAX) used when this template''s campaign '
  'reaches meta-campaign-create, e.g. ''OUTCOME_AWARENESS'' or '
  '''OUTCOME_TRAFFIC''.';
comment on column campaign_templates.access_tier is
  '''free'' = available to any signed-in user; ''premium'' = the Grow tab '
  'card is locked unless the user has grow_access (the RevenueCat '
  'entitlement already used elsewhere in the app for this same tier split).';
comment on column campaign_templates.requires_connected_page is
  'Whether this template needs an active profile_meta_connections row (a '
  'connected Facebook Page) before it can be used — e.g. any '
  'existing_post template. When true and there''s no active connection, '
  'the content sheet shows a ''connect your Page'' note instead of the '
  'normal content flow.';
comment on column campaign_templates.requires_eligibility_check is
  'Whether existing-post candidates for this template need Meta''s boost-'
  'eligibility check (meta-page-posts'' boost_eligibility_info) before '
  'being selectable. When true, ineligible posts are greyed out and '
  'unselectable in the picker, with the reason shown.';
comment on column campaign_templates.delivery is
  '''self_serve'' = the artist completes this template entirely in-app; '
  '''contact'' = tapping the card opens SQRZ''s existing discovery-call '
  'action instead of the create sheet (e.g. a managed/Custom template).';
comment on column campaign_templates.status is
  '''active'' = shown and tappable; ''coming_soon'' = shown, locked, not '
  'tappable; ''hidden'' = not shown at all — also enforced by RLS, so a '
  'hidden row is not even readable by an authenticated client.';
comment on column campaign_templates.sort_order is
  'Display order on the Grow tab, ascending.';
comment on column campaign_templates.available_from is
  'Optional visibility window start. Outside the available_from/'
  'available_until window, the client treats the template as if '
  'status=''hidden'' even though RLS still returns the row — lets Will '
  'stage a future template ahead of time without it appearing early.';
comment on column campaign_templates.available_until is
  'Optional visibility window end. See available_from.';
comment on column campaign_templates.notes is
  'Free-text internal notes for Will — never read or shown by any client.';

alter table campaign_templates enable row level security;

-- Authenticated users can read any non-hidden row; no insert/update/delete
-- policy exists at all — writes only ever happen via the Table Editor /
-- service role, which bypasses RLS entirely (matches this project's "no
-- client writes" convention for config-only tables).
create policy campaign_templates_read
  on campaign_templates
  for select
  to authenticated
  using (status <> 'hidden');

-- boost_campaigns.campaign_template becomes a real FK into campaign_templates
-- (2026-10-25) — replaces the hardcoded CHECK added 2026-10-24 (which only
-- ever allowed the three literal values 'template_01'/'template_02'/
-- 'custom'). NOT VALID: Will hasn't created any campaign_templates rows yet,
-- so the two existing campaigns' values ('template_01'/'template_02') would
-- otherwise fail an immediate validation scan — NOT VALID skips that scan
-- and still fully enforces the constraint for any NEW insert/update of this
-- column going forward. ON UPDATE CASCADE: campaign_templates.id can be
-- safely renamed later without orphaning any campaign that references it.
--
-- Follow-up, not run here (would fail until the rows exist): once Will adds
-- 'template_01' and 'template_02' rows, run
--   ALTER TABLE boost_campaigns VALIDATE CONSTRAINT boost_campaigns_campaign_template_fkey;
-- to clear the NOT VALID flag with a one-time scan. Not required for the FK
-- to work correctly in the meantime — only cosmetic/completeness.
alter table boost_campaigns drop constraint if exists boost_campaigns_campaign_template_check;

alter table boost_campaigns
  add constraint boost_campaigns_campaign_template_fkey
  foreign key (campaign_template) references campaign_templates(id)
  on update cascade
  not valid;

-- campaign_activation_products is superseded by campaign_templates.
-- iap_product_id (2026-10-25) — verify-campaign-activation and
-- apple-consumable-webhook now read the product id straight off the
-- campaign's template row instead of this table. Left in place (not
-- dropped — matches this project's "deprecate, don't drop" convention),
-- just unused by any application code from here on.
comment on table campaign_activation_products is
  'DEPRECATED 2026-10-25 — superseded by campaign_templates.iap_product_id. '
  'verify-campaign-activation and apple-consumable-webhook no longer read '
  'this table; left in place rather than dropped, per this project''s '
  'standing convention. Do not add new code against this table.';
