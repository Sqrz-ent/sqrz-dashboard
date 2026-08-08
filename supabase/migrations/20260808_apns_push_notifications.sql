-- APNs push notifications (2026-08-08)
--
-- 1. Device-token column on profiles, written by sqrz-ios on
--    didRegisterForRemoteNotificationsWithDeviceToken (replaces UserDefaults-
--    only storage there).
-- 2. Shared secret + accessor authenticating the notifications-insert trigger's
--    call to the apns-push edge function -- same pattern as meta_sync_secret
--    (see 20260802_meta_insights_sync_secret_and_accessor.sql), its own
--    name/value so it isn't confusingly Meta-branded for an unrelated feature.
-- 3. Trigger: AFTER INSERT ON notifications WHEN push_worthy = true -> the
--    apns-push edge function, mirroring the on_boost_campaign_submit_meta_create
--    / on_wallet_ledger_entry_insert_meta_budget trigger shape exactly.
--
-- Real APNs credentials (APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID) are edge
-- function environment secrets, set separately (not via Vault, not via this
-- migration -- same as HUBSPOT_TOKEN/META_APP_SECRET) -- until they're set,
-- the apns-push function logs "APNs secrets not configured" and exits
-- cleanly rather than failing. See root CLAUDE.md's Known Open Issues.

alter table public.profiles add column if not exists apns_device_token text;

comment on column public.profiles.apns_device_token is
  'iOS APNs device token, written by the app on didRegisterForRemoteNotificationsWithDeviceToken. Null = push not yet granted/registered for this profile.';

-- Idempotent: only mints the secret if one with this name doesn't already
-- exist, so a migration replay doesn't create a duplicate.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_sync_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'push_sync_secret',
      'Shared secret: notifications-insert trigger -> apns-push edge function auth'
    );
  end if;
end $$;

create or replace function public.get_push_sync_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'push_sync_secret'
  limit 1;
$$;

revoke all on function public.get_push_sync_secret() from public, anon, authenticated;
grant execute on function public.get_push_sync_secret() to service_role;

create or replace function public.trigger_apns_push()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/apns-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_sync_secret')
    ),
    body := jsonb_build_object('notification_id', new.id)
  );
  return new;
end;
$function$;

create trigger on_notification_insert_apns_push
  after insert on public.notifications
  for each row
  when (new.push_worthy = true)
  execute function public.trigger_apns_push();
