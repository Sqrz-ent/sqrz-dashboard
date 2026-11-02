-- outlet_sandbox.manual_campaigns — log of campaigns booked by hand on platforms
-- WITHOUT an API (AudioGO, Blip, Acast, iHeart AdBuilder, Bandsintown, Audiomack
-- Sponsored Songs, SoundCloud Promote, AppLovin, …). Written/read only by the
-- sandbox-manual edge function.   NOT APPLIED — review, then apply manually.
--
-- Same isolation and access rules as outlet_sandbox.outlet_runs / outlet_objects
-- (20261101_outlet_sandbox.sql): own schema, NOT exposed via PostgREST, RLS on with
-- zero policies, all grants revoked from anon/authenticated, service_role only.
-- Touches no existing table.

create table if not exists outlet_sandbox.manual_campaigns (
  id            uuid primary key default gen_random_uuid(),
  outlet        text not null check (outlet ~ '^[a-z0-9_]{2,40}$'),   -- 'audiogo', 'blip', 'acast', …
  name          text not null check (char_length(name) between 1 and 200),
  status        text not null default 'planned'
                check (status in ('planned', 'booked', 'running', 'done', 'cancelled')),
  booked_at     timestamptz,
  starts_at     timestamptz,
  ends_at       timestamptz,
  budget        numeric(12, 2) check (budget is null or budget >= 0),
  currency      text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  spend         numeric(12, 2) not null default 0 check (spend >= 0),
  targeting     jsonb not null default '{}'::jsonb,      -- audience / geo / genre / placement, as the platform words it
  creative_ref  text,                                    -- file name, URL or platform asset id of the creative
  landing_url   text check (landing_url is null or landing_url ~ '^https://[a-z0-9-]+\.sqrz\.com(/.*)?$'),
  results       jsonb not null default '{}'::jsonb,      -- impressions, clicks, listens, conversions, … whatever the platform reports
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint manual_campaigns_flight_check check (ends_at is null or starts_at is null or ends_at >= starts_at)
);

comment on table outlet_sandbox.manual_campaigns is
  'Manually booked campaigns on platforms without an API. Written by the sandbox-manual edge function (service role). Not connected to the live app.';
comment on column outlet_sandbox.manual_campaigns.results is
  'Free-form platform-reported results, e.g. {"impressions":12000,"clicks":150,"listens":900,"conversions":4}. The sandbox-manual update action shallow-merges into this.';

create index if not exists manual_campaigns_outlet_status_idx
  on outlet_sandbox.manual_campaigns (outlet, status, created_at desc);
create index if not exists manual_campaigns_created_idx
  on outlet_sandbox.manual_campaigns (created_at desc);

-- Keep updated_at honest regardless of who writes.
create or replace function outlet_sandbox.manual_campaigns_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists manual_campaigns_updated_at on outlet_sandbox.manual_campaigns;
create trigger manual_campaigns_updated_at
before update on outlet_sandbox.manual_campaigns
for each row execute function outlet_sandbox.manual_campaigns_set_updated_at();

-- Access: service role only (RLS on, no policies, grants revoked) — identical to outlet_runs.
alter table outlet_sandbox.manual_campaigns enable row level security;
revoke all on outlet_sandbox.manual_campaigns from public, anon, authenticated;
revoke all on function outlet_sandbox.manual_campaigns_set_updated_at() from public, anon, authenticated;
grant select, insert, update, delete on outlet_sandbox.manual_campaigns to service_role;
