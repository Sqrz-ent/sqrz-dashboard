-- Persistence for the campaign-advisor output. Append-only: every advisor call
-- inserts a new row; nothing is ever updated or deleted. The UI surfaces only
-- the latest row per campaign for now, but full history is kept (cheap) so a
-- comparison view can be built later without a second migration.
create table if not exists public.campaign_advisor_runs (
  id uuid primary key default gen_random_uuid(),
  boost_campaign_id uuid not null references public.boost_campaigns(id),
  result jsonb not null,
  created_at timestamptz not null default now()
);

-- Fast latest-lookup per campaign.
create index if not exists campaign_advisor_runs_campaign_created_idx
  on public.campaign_advisor_runs (boost_campaign_id, created_at desc);
