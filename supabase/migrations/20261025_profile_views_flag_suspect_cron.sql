-- Re-apply the bot-flagging rules to recent views every hour, so new
-- datacenter bursts / periodic monitors drop out of analytics automatically.
-- 3-day lookback: the periodic rule needs several hits per day to recognise
-- a monitor. The function is idempotent (only flips not-yet-flagged rows).
select cron.schedule(
  'flag-suspect-profile-views',
  '17 * * * *',
  $$select public.flag_suspect_profile_views(now() - interval '3 days')$$
);
