-- Fix: runaway duplicate HubSpot deals + duplicate campaign_status notifications.
--
-- ROOT CAUSE (confirmed via live evidence, not assumed -- see investigation below):
-- `on_boost_campaign_hubspot_sync` was `AFTER INSERT OR UPDATE` with no column
-- scope, so ANY write to a boost_campaigns row (including columns that never
-- touch the synced deal, e.g. stat_* Meta-entered performance numbers) queued
-- an async `net.http_post` call to hubspot-sync-deal. That function decided
-- create-vs-patch off `record.hubspot_deal_id` -- the trigger PAYLOAD's snapshot
-- of NEW at the moment that specific statement committed -- not a fresh read of
-- the row at the time the (queued, asynchronously-delivered) HTTP call actually
-- executed. Because net.http_post decouples "when the row changed" from "when
-- the HTTP call runs," any row touched more than once before the FIRST
-- invocation's HubSpot-create + write-back round trip finished had every one of
-- those extra invocations independently see hubspot_deal_id = null and each
-- create its own deal.
--
-- Confirmed against real data: the 2026-08-03 17:33 demo-account seed migration
-- (`demo_account_test_campaigns_and_wallet`) inserted 3 test campaigns, one of
-- which (`id = 11111111-...`) was never touched again -- it has exactly 1
-- HubSpot deal. The other two were each touched by at least one more UPDATE
-- (copying in stat_* values) -- `Weekend Warmup Tour` (`22222222-...`) has 91
-- duplicate deals, `Spring Residency Boost` (`33333333-...`) has 590. That 1
-- vs. 91 vs. 590 spread is direct proof of the mechanism: rows touched once are
-- unaffected, rows touched repeatedly in the open race window accumulate
-- duplicates roughly proportional to how many times they were touched (the
-- committed migration file itself only shows 1-2 statements per row, so most of
-- that repeated touching was evidently iterative/exploratory raw SQL that was
-- never captured in a tracked migration -- also true of the ORIGINAL hubspot
-- trigger creation and the duplicate notify trigger below, neither of which
-- exist anywhere in this repo's migration history; both were applied directly
-- to the live DB. That drift is itself worth closing going forward.)
--
-- Separately confirmed NOT to require bulk/raw-SQL usage to be a real risk:
-- a real customer campaign (`a395518f-...`, "Summer Promo Tour") went through 4
-- genuine status transitions via normal one-campaign-at-a-time app usage and
-- picked up ZERO duplicate deals (each transition was spaced far enough apart,
-- by human interaction, for the prior async round trip to finish first) --
-- but it DID pick up 2 duplicate notification rows (see below), because that
-- half of the bug is not a race condition at all, just two triggers both firing
-- unconditionally on every status change. The HubSpot race is real but
-- low-probability under human-paced single-campaign usage and effectively
-- certain under any rapid/scripted/bulk multi-touch usage.
--
-- FIX, part 1 (this migration): scope the trigger to only the columns that
-- actually feed the synced deal (mirrors the already-correct
-- `on_campaign_status_notify ... AFTER UPDATE OF status` pattern), and add a
-- `hubspot_sync_status` claim column so the companion edge-function fix (see
-- supabase/functions/hubspot-sync-deal/index.ts, deployed alongside this
-- migration) can atomically guarantee at most one concurrent/rapid-fire
-- invocation ever creates a deal for a given campaign, checked against the
-- row's real committed state rather than a stale trigger-payload snapshot.
-- Left DISABLED here -- re-enabled in a follow-up migration only once the
-- edge-function fix is deployed and verified.
alter table public.boost_campaigns
  add column if not exists hubspot_sync_status text;

alter table public.boost_campaigns
  drop constraint if exists boost_campaigns_hubspot_sync_status_check;
alter table public.boost_campaigns
  add constraint boost_campaigns_hubspot_sync_status_check
  check (hubspot_sync_status is null or hubspot_sync_status = 'creating');

comment on column public.boost_campaigns.hubspot_sync_status is
  'Transient claim marker for hubspot-sync-deal''s atomic create-lock: set to '
  '''creating'' for the duration of the HubSpot deal POST, then cleared back to '
  'null (success: alongside hubspot_deal_id; failure: alone, so a later sync '
  'event can retry). A conditional UPDATE ... WHERE hubspot_deal_id IS NULL AND '
  'hubspot_sync_status IS NULL acts as a mutual-exclusion lock so at most one '
  'concurrent/rapid-fire invocation ever creates a deal for a given campaign. '
  'If stuck on ''creating'' (e.g. the function crashed mid-flight), clear it '
  'manually to unblock a retry -- same operational shape as meta_sync_status.';

-- Payload is now a wake-up signal only (id + op), not data -- the edge function
-- always re-fetches the current committed row itself rather than trusting NEW,
-- for exactly the reason described above.
create or replace function public.trigger_hubspot_sync_deal()
returns trigger
language plpgsql
security definer
as $function$
begin
  perform net.http_post(
    url := 'https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/hubspot-sync-deal',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('type', TG_OP, 'record', jsonb_build_object('id', NEW.id))
  );
  return new;
end;
$function$;

drop trigger if exists on_boost_campaign_hubspot_sync on public.boost_campaigns;
create trigger on_boost_campaign_hubspot_sync
  after insert or update of
    name, status, budget_currency, campaign_type, goal,
    channels, channel, target_audience, notes, creative_asset_url,
    starts_at, ends_at
  on public.boost_campaigns
  for each row execute function public.trigger_hubspot_sync_deal();

-- Stays disabled until the edge-function fix is deployed and verified --
-- see the follow-up "reenable_hubspot_deal_sync_trigger" migration.
alter table public.boost_campaigns disable trigger on_boost_campaign_hubspot_sync;

-- FIX, part 2: duplicate campaign_status notifications.
--
-- `on_campaign_status_notify` (`AFTER UPDATE OF status`, correctly scoped since
-- its original 2026-07-19 creation) and `on_boost_campaign_status_change_notify`
-- (`AFTER UPDATE`, unscoped, added redundantly by the 2026-08-03 16:02
-- `campaign_status_notifications` migration -- which only needed to update the
-- function body via CREATE OR REPLACE, and didn't need a second trigger at all)
-- both call notify_campaign_status_change(). Not a race condition -- a
-- deterministic double-insert on every single status change since 2026-08-03
-- 16:02:48. Confirmed on real data: campaign a395518f-... picked up an exact
-- duplicate pair (same profile_id/related_id/subtype/created_at down to the
-- microsecond -- both inserted by the same UPDATE's two trigger firings) at
-- 2026-08-03 16:27:38 and again at 22:28:34.
--
-- Removes the redundant, incorrectly-scoped trigger; keeps only the original,
-- correctly-scoped on_campaign_status_notify. notify_campaign_status_change()
-- itself is unchanged (its current, 2026-08-03 body is correct and stays).
drop trigger if exists on_boost_campaign_status_change_notify on public.boost_campaigns;
