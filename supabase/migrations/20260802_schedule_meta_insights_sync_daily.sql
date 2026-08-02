-- Daily read-only Meta Insights pull into boost_campaigns.stat_*.
-- Same mechanism as the existing 'auto-complete-expired-campaigns' pg_cron job;
-- runs at 02:30 UTC, 30 min after that 02:00 job, so a campaign auto-completed
-- overnight still gets a final stats sync the same night. Invokes the
-- meta-insights-sync edge function via pg_net, authenticating with the shared
-- secret read from Vault (never hardcoded in the schedule).
--
-- cron.schedule upserts by job name, so this is safe to replay.
select cron.schedule(
  'meta-insights-sync-daily',
  '30 2 * * *',
  $cron$
  select net.http_post(
    url := 'https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/meta-insights-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);
