-- Per-profile connection to the artist's own Facebook Page (+ linked
-- Instagram account), so SQRZ-run campaigns for that profile can post as the
-- artist's identity instead of SQRZ's. Ads still run in SQRZ's own ad
-- account/wallet — this table only tracks identity, never budget/billing.
--
-- No long-lived user tokens are stored here or anywhere else for this
-- feature — the artist's Facebook login is used client-side only, to list
-- their Pages; once a page_id is chosen, everything after that (the
-- business-asset-sharing request, status checks, disconnect) uses SQRZ's
-- own business credentials (meta_ad_accounts.system_user_token), not the
-- artist's token.
create table public.profile_meta_connections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  page_id text,
  page_name text,
  instagram_user_id text,
  instagram_username text,
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked', 'failed')),
  requested_at timestamptz,
  approved_at timestamptz,
  last_checked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at
  before update on public.profile_meta_connections
  for each row execute function public.handle_updated_at();

alter table public.profile_meta_connections enable row level security;

-- Owner-read only. All writes (insert/update) go through the
-- meta-page-connect / meta-page-connection-status / meta-page-disconnect
-- edge functions using the service role, which bypasses RLS entirely —
-- same pattern as campaign_budgets / wallet_ledger_entries.
create policy profile_meta_connections_owner_select
  on public.profile_meta_connections
  for select
  using (user_owns_profile(profile_id));
