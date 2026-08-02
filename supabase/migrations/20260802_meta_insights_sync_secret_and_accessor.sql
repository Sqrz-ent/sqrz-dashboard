-- Shared secret authenticating the daily pg_cron call to the meta-insights-sync
-- edge function. Lives ONLY in Vault (encrypted); generated in-DB so its value
-- never enters source control. Both the cron command and the edge function read
-- it from Vault (the function via the SECURITY DEFINER accessor below, since the
-- vault schema isn't exposed through PostgREST).
--
-- Idempotent: only mints the secret if one with this name doesn't already exist,
-- so a migration replay (e.g. `supabase db reset`) doesn't create a duplicate.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'meta_sync_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'meta_sync_secret',
      'Shared secret: pg_cron -> meta-insights-sync edge function auth'
    );
  end if;
end $$;

-- Accessor for the edge function's service-role client. service_role only.
create or replace function public.get_meta_sync_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'meta_sync_secret'
  limit 1;
$$;

revoke all on function public.get_meta_sync_secret() from public, anon, authenticated;
grant execute on function public.get_meta_sync_secret() to service_role;
