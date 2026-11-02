-- Link sandbox campaigns to clients: nullable profile_id (→ public.profiles.id) and
-- hubspot_deal_id on outlet_sandbox.manual_campaigns, outlet_runs and outlet_objects.
--   NOT APPLIED — review, then apply manually.
--
-- Requires 20261101_outlet_sandbox.sql and 20261103_outlet_sandbox_manual_campaigns.sql
-- (it sorts after both). Additive and nullable: existing rows and callers are unaffected.
-- No existing public table is modified; the only reference to the live schema is the FK
-- target public.profiles(id). Access rules are unchanged (service role only).
--
-- profile_id: ON DELETE SET NULL — deleting a profile must not delete the sandbox log.
-- hubspot_deal_id: HubSpot deal object ids are numeric; stored as text.

alter table outlet_sandbox.manual_campaigns
  add column if not exists profile_id uuid references public.profiles (id) on delete set null,
  add column if not exists hubspot_deal_id text check (hubspot_deal_id is null or hubspot_deal_id ~ '^[0-9]{1,20}$');

alter table outlet_sandbox.outlet_runs
  add column if not exists profile_id uuid references public.profiles (id) on delete set null,
  add column if not exists hubspot_deal_id text check (hubspot_deal_id is null or hubspot_deal_id ~ '^[0-9]{1,20}$');

alter table outlet_sandbox.outlet_objects
  add column if not exists profile_id uuid references public.profiles (id) on delete set null,
  add column if not exists hubspot_deal_id text check (hubspot_deal_id is null or hubspot_deal_id ~ '^[0-9]{1,20}$');

comment on column outlet_sandbox.manual_campaigns.profile_id is 'Client profile (public.profiles.id) this campaign was run for. Nullable.';
comment on column outlet_sandbox.manual_campaigns.hubspot_deal_id is 'HubSpot deal id (numeric text) this campaign belongs to. Nullable.';
comment on column outlet_sandbox.outlet_runs.profile_id is 'Client profile the call was made for (from the optional profile_id param). Nullable.';
comment on column outlet_sandbox.outlet_runs.hubspot_deal_id is 'HubSpot deal id the call was made for (from the optional hubspot_deal_id param). Nullable.';
comment on column outlet_sandbox.outlet_objects.profile_id is 'Client profile the object was created for. Nullable.';
comment on column outlet_sandbox.outlet_objects.hubspot_deal_id is 'HubSpot deal id the object was created for. Nullable.';

-- Partial indexes: most rows have no client link.
create index if not exists manual_campaigns_profile_idx on outlet_sandbox.manual_campaigns (profile_id) where profile_id is not null;
create index if not exists manual_campaigns_deal_idx    on outlet_sandbox.manual_campaigns (hubspot_deal_id) where hubspot_deal_id is not null;
create index if not exists outlet_runs_profile_idx      on outlet_sandbox.outlet_runs (profile_id) where profile_id is not null;
create index if not exists outlet_runs_deal_idx         on outlet_sandbox.outlet_runs (hubspot_deal_id) where hubspot_deal_id is not null;
create index if not exists outlet_objects_profile_idx   on outlet_sandbox.outlet_objects (profile_id) where profile_id is not null;
create index if not exists outlet_objects_deal_idx      on outlet_sandbox.outlet_objects (hubspot_deal_id) where hubspot_deal_id is not null;
