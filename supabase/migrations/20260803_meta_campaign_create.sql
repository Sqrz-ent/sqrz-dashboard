-- Meta campaign creation (Campaign → Ad Set → Ad → Creative) + ad-set budget sync
-- (2026-08-03). Completes the Meta lifecycle: boost_campaigns rows were configured
-- locally but never pushed to Meta (only the READ side existed — meta-insights-sync
-- pulls stats for a meta_campaign_id that used to be set by hand). This adds the
-- WRITE side, driven entirely by DB triggers → edge functions, mirroring the
-- hubspot-sync-deal / hubspot-sync-campaign-budget async pattern (no Node route
-- change; the artist's existing "submit for review" transition is the trigger).
--
--   • on_boost_campaign_submit_meta_create — fires the first time a Meta campaign
--     reaches status='in_review' (creative submitted) with no meta_campaign_id yet.
--     The meta-campaign-create function uploads the media and builds the PAUSED
--     object chain, writing the ids back. Guarded on meta_campaign_id IS NULL so a
--     needs_changes→in_review resubmit never creates a second chain.
--   • on_wallet_ledger_entry_insert_meta_budget — parallel to the existing HubSpot
--     budget-sync trigger, on the SAME allocation/deallocation events. PATCHes the
--     ad set's lifetime_budget to the campaign's running allocated total. Kept as a
--     separate function/trigger from the HubSpot one so a Meta failure and a HubSpot
--     failure never block each other.
--
-- Both functions authenticate with the shared meta_sync_secret from Vault (same
-- secret + get_meta_sync_secret() the insights sync uses), injected as x-sync-secret.

-- ── Columns ──────────────────────────────────────────────────────────────────

-- SQRZ's Facebook Page behind every ad for this account (V1: SQRZ-only identity,
-- no per-artist Page). Nullable — meta-campaign-create resolves it at runtime from
-- the business's owned pages and caches it back here on first use.
alter table public.meta_ad_accounts
  add column if not exists page_id text;

comment on column public.meta_ad_accounts.page_id is
  'SQRZ Facebook Page id used as the identity for ads under this ad account (V1: SQRZ-only). Resolved/cached by the meta-campaign-create edge function.';

-- Meta push status tracking on the campaign — surfaces partial-failure detail for
-- the admin who does the manual publish, and gives the create function idempotency
-- (re-check meta_campaign_id IS NULL, mark 'creating' before the chain runs).
alter table public.boost_campaigns
  add column if not exists meta_sync_status text
    check (meta_sync_status in ('creating', 'created', 'failed')),
  add column if not exists meta_sync_error text,
  add column if not exists meta_synced_at timestamptz;

comment on column public.boost_campaigns.meta_sync_status is
  'Meta object-creation state: creating | created | failed. NULL = never attempted. Set by the meta-campaign-create edge function.';
comment on column public.boost_campaigns.meta_sync_error is
  'Last Meta push failure detail (for admin debug/retry). Set alongside meta_sync_status=failed.';

-- ── Trigger 1: create the Meta object chain on creative submission ────────────

create or replace function public.trigger_meta_campaign_create()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/meta-campaign-create',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_secret')
    ),
    body := jsonb_build_object('campaign_id', NEW.id),
    timeout_milliseconds := 120000
  );
  return new;
end;
$function$;

-- Fires only on the transition INTO in_review, only when no Meta campaign exists
-- yet, and only for Meta-channel campaigns. The write-back the edge function does
-- (meta_sync_status='creating', then the ids) never re-satisfies this WHEN clause
-- (status is already in_review), so there's no recursion.
drop trigger if exists on_boost_campaign_submit_meta_create on public.boost_campaigns;
create trigger on_boost_campaign_submit_meta_create
  after update on public.boost_campaigns
  for each row
  when (
    NEW.status = 'in_review'
    and OLD.status is distinct from 'in_review'
    and NEW.meta_campaign_id is null
    and NEW.channels is not null
    and 'meta' = any(NEW.channels)
  )
  execute function public.trigger_meta_campaign_create();

-- ── Trigger 2: sync the ad set's budget on every allocation event ─────────────

create or replace function public.trigger_meta_adset_budget_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/meta-adset-budget-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_secret')
    ),
    body := jsonb_build_object('campaign_id', NEW.campaign_id),
    timeout_milliseconds := 60000
  );
  return new;
end;
$function$;

-- Same event surface as on_wallet_ledger_entry_insert_hubspot_sync (allocation /
-- deallocation with a campaign_id), running independently alongside it.
drop trigger if exists on_wallet_ledger_entry_insert_meta_budget on public.wallet_ledger_entries;
create trigger on_wallet_ledger_entry_insert_meta_budget
  after insert on public.wallet_ledger_entries
  for each row
  when (NEW.entry_type in ('allocation', 'deallocation') and NEW.campaign_id is not null)
  execute function public.trigger_meta_adset_budget_sync();
