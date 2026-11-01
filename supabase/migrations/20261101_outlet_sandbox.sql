-- ─────────────────────────────────────────────────────────────────────────────
-- outlet_sandbox — isolated sandbox for future ad outlets (Google Ads first).
--
-- NOT APPLIED. Review, then apply manually.
--
-- Isolation rules:
--   * Own schema; touches NO existing table (boost_campaigns, campaign_templates, …).
--   * NOT exposed via PostgREST: do NOT add `outlet_sandbox` to Settings → API →
--     "Exposed schemas" (or db_schemas / db_extra_search_path). The sandbox edge
--     function reaches it through a direct Postgres connection (SUPABASE_DB_URL),
--     because supabase-js can only talk to PostgREST-exposed schemas.
--   * RLS on, zero policies, all grants revoked from anon/authenticated — only
--     service_role / postgres (the direct connection) can read or write.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists outlet_sandbox;

revoke all on schema outlet_sandbox from public, anon, authenticated;
grant usage on schema outlet_sandbox to service_role;

-- Log of every sandbox call (one row per request to a sandbox-* function).
create table if not exists outlet_sandbox.outlet_runs (
  id          uuid primary key default gen_random_uuid(),
  outlet      text not null,                      -- 'google', later 'tiktok', …
  action      text not null,                      -- 'ping' | 'upload_video' | …
  request     jsonb,                              -- params as received (secrets redacted by the function)
  response    jsonb,                              -- adapter result, or error detail
  status      text not null default 'running'
              check (status in ('running', 'ok', 'error')),
  error       text,
  created_at  timestamptz not null default now()
);

-- IDs of everything created in the sandbox (videos, campaigns, ad groups, ads, assets).
create table if not exists outlet_sandbox.outlet_objects (
  id                  uuid primary key default gen_random_uuid(),
  outlet              text not null,
  object_type         text not null,              -- 'youtube_video' | 'campaign' | 'campaign_budget' | 'ad_group' | 'ad' | 'asset'
  external_id         text not null,              -- id (or resource name) on the outlet's side
  parent_external_id  text,                       -- e.g. ad -> ad group, ad group -> campaign
  raw                 jsonb,                      -- raw outlet payload / extra context
  run_id              uuid references outlet_sandbox.outlet_runs (id) on delete set null,
                                                  -- (addition to the spec'd columns: links an object to the call that made it)
  created_at          timestamptz not null default now()
);

create index if not exists outlet_runs_outlet_created_idx
  on outlet_sandbox.outlet_runs (outlet, created_at desc);
create index if not exists outlet_objects_lookup_idx
  on outlet_sandbox.outlet_objects (outlet, object_type, external_id);

alter table outlet_sandbox.outlet_runs    enable row level security;
alter table outlet_sandbox.outlet_objects enable row level security;
-- (intentionally no policies: nothing but service_role / postgres bypasses RLS)

revoke all on all tables    in schema outlet_sandbox from public, anon, authenticated;
revoke all on all sequences in schema outlet_sandbox from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema outlet_sandbox to service_role;

comment on schema outlet_sandbox is
  'Isolated outlet (ad platform) sandbox. Not exposed via PostgREST. Not connected to the live app.';
