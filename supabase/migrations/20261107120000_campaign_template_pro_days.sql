-- Campaign templates can include a Pro period (2026-11-02).
--
-- Buying such a template (consumable IAP) grants Pro — the RevenueCat
-- `grow_access` entitlement, via a promotional grant, the same mechanism and
-- entitlement redeem-invite-code uses — for `pro_days` days. See
-- docs/campaigns/template-pro-days.md for the full behaviour.
--
-- SCHEMA ONLY. No values are set here: Will sets pro_days per template himself
-- (Table Editor / Airtable). NULL or 0 = no Pro included.

alter table public.campaign_templates
  add column pro_days integer;

alter table public.campaign_templates
  add constraint campaign_templates_pro_days_check
  check (pro_days is null or pro_days >= 0);

comment on column public.campaign_templates.pro_days is
  'Days of Pro (RevenueCat grow_access promotional entitlement) granted when this template''s activation IAP is purchased. NULL or 0 = no Pro included. Read at grant time by the verify-campaign-activation / apple-consumable-webhook edge functions; the value actually granted is recorded on campaign_activations.pro_days_granted. Edited by hand — no app-level validation beyond >= 0.';

-- Per-purchase record of the Pro grant — this is what makes the grant
-- idempotent: a retried webhook / client verification finds pro_granted_at set
-- and never grants twice. Written only by the edge functions (service role);
-- the existing owner-select RLS policy on campaign_activations already lets the
-- owner read these columns.
alter table public.campaign_activations
  add column pro_days_granted    integer,
  add column pro_grant_started_at timestamptz,
  add column pro_granted_at      timestamptz,
  add column pro_granted_until   timestamptz;

comment on column public.campaign_activations.pro_days_granted is
  'Pro days granted for this purchase (0 = the template included none at purchase time, or the user already had lifetime Pro). NULL = grant not yet processed.';
comment on column public.campaign_activations.pro_grant_started_at is
  'Claim marker: set while an edge function is calling RevenueCat for this purchase, so concurrent webhook/client paths don''t both grant. Cleared again if the RevenueCat call fails; a claim older than a few minutes is treated as abandoned.';
comment on column public.campaign_activations.pro_granted_at is
  'When the grant decision for this purchase was finalised. Non-null = done, never grant again for this transaction.';
comment on column public.campaign_activations.pro_granted_until is
  'End of the Pro access after this grant (max(current promotional end, now) + pro_days). NULL with pro_granted_at set = nothing was granted, or the user already had lifetime Pro.';
