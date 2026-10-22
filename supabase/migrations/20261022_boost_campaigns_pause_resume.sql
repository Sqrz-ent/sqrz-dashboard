-- Manual Pause/Resume for live Meta campaigns (2026-10-22). Deliberately a
-- SEPARATE flag from boost_campaigns.status — status stays 'live' while
-- paused (matches meta-status-webhook's own existing posture of never
-- forcing a status change on a PAUSED-ish signal from Meta; see the report
-- for confirmation it was already built this way, independently, before
-- this column existed).
alter table boost_campaigns
  add column is_paused boolean not null default false,
  add column paused_at timestamptz;

comment on column boost_campaigns.is_paused is 'Manually paused via meta-campaign-toggle — delivery stopped at Meta, but status stays live (this is a pause/resume toggle, not a lifecycle transition).';
comment on column boost_campaigns.paused_at is 'When the campaign was LAST paused. Set on pause, left as-is on resume (so it still answers "when was this last paused" after resuming) — is_paused is the live current-state flag.';

-- Append-only audit log — "log each toggle with timestamp" (distinct from
-- the current-state columns above, which only ever hold the latest value).
create table boost_campaign_toggle_log (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references boost_campaigns(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  action text not null check (action in ('pause', 'resume')),
  toggled_at timestamptz not null default now()
);

create index boost_campaign_toggle_log_campaign_id_idx on boost_campaign_toggle_log (campaign_id);

alter table boost_campaign_toggle_log enable row level security;

create policy boost_campaign_toggle_log_owner_select
  on boost_campaign_toggle_log
  for select
  using (user_owns_profile(profile_id));

-- Writes only via meta-campaign-toggle (service_role) — no owner-write
-- policy, same convention as every other append-only log table in this
-- project (apple_webhook_events, campaign_advisor_runs, etc.).
