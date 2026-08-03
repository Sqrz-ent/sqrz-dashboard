-- HubSpot deal amount + Notes history, kept current at every allocation event
-- (2026-08-03). Previously the deal's `amount` was written once, from
-- boost_campaigns.budget_amount, by hubspot-sync-deal — but budget_amount is
-- no longer set anywhere (pricing moved to the wallet allocation flow), so
-- that write is a permanent stale 0. This adds a new trigger, scoped to
-- wallet_ledger_entries rows that actually move a campaign's allocated_cents
-- (entry_type 'allocation' or 'deallocation', reallocation produces one of
-- each), that fires an edge function to PATCH the deal's `amount` to the
-- campaign's current running total and log a Note with the event.
--
-- A NEW sqrz_budget_allocated custom property was explicitly out of scope for
-- this pass — HubSpot's plan doesn't allow custom deal properties (see
-- hubspot-sync-deal's header comment / commits ccfa33a, e6a5b1a, both
-- 2026-07-08, which dropped all sqrz_* custom properties for exactly this
-- reason) — confirmed with the user rather than building something that
-- would silently fail. `amount` (a default property) carries the running
-- total instead.
create or replace function public.trigger_hubspot_sync_campaign_budget()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/hubspot-sync-campaign-budget',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('type', TG_OP, 'record', row_to_json(NEW))
  );
  return new;
end;
$function$;

create trigger on_wallet_ledger_entry_insert_hubspot_sync
  after insert on public.wallet_ledger_entries
  for each row
  when (NEW.entry_type in ('allocation', 'deallocation') and NEW.campaign_id is not null)
  execute function public.trigger_hubspot_sync_campaign_budget();
