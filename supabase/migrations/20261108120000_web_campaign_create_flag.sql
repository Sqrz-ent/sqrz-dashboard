-- Web campaign creation switch (2026-11-02).
--
-- app_config.web_campaign_create_enabled controls whether the web dashboard's
-- Grow section offers "create a campaign" (the button on template cards, the
-- /analytics/campaigns/new/:templateId route and its action, and the location-search
-- helper). Same shape as the other flags in this table (purchase_gate_enabled,
-- companion_subscription_enabled): jsonb boolean, world-readable, written only by
-- the service role / Table Editor.
--
-- Defaults to FALSE — creation stays hidden until you flip it to true. The create
-- code is intact; this only decides whether it is reachable. Re-running is safe
-- (an existing value is never overwritten).

insert into public.app_config (key, value)
values ('web_campaign_create_enabled', 'false'::jsonb)
on conflict (key) do nothing;
