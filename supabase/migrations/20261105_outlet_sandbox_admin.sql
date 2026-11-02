-- outlet_sandbox admin backend: outlet registry + setup status, and Vault-backed API keys.
--   NOT APPLIED — review, then apply manually.
--
-- Requires 20261101_outlet_sandbox.sql (schema outlet_sandbox) and uses Supabase Vault (already
-- in use in this project, e.g. 20260802_meta_insights_sync_secret_and_accessor.sql).
-- Drives the sandbox-admin edge function (the iOS "sandbox sheet"). Touches no existing table.
--
-- Access rules: same as the other outlet_sandbox tables — own schema, NOT exposed via PostgREST,
-- RLS on with zero policies, all grants revoked from anon/authenticated, service role only.
-- The secret functions below are SECURITY DEFINER, executable by service_role only, and live in
-- outlet_sandbox on purpose: they are called by the sandbox edge functions over their direct
-- Postgres connection (like all other outlet_sandbox access), so nothing is added to the public
-- API surface. (Unlike public.get_meta_sync_secret they are therefore NOT reachable via PostgREST.)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. outlets — one row per connector / manual outlet, with setup progress
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists outlet_sandbox.outlets (
  outlet            text primary key check (outlet ~ '^[a-z0-9_]{1,40}$'),   -- same tokens as outlet_runs.outlet etc.
  display_name      text not null,
  kind              text not null check (kind in ('api', 'manual')),
  status            text not null default 'not_started'
                    check (status in ('not_started', 'account_created', 'applied', 'approved', 'keys_set', 'connected')),
  checklist         jsonb not null default '[]'::jsonb check (jsonb_typeof(checklist) = 'array'),  -- ordered [{key,label,done}]
  required_secrets  text[] not null default '{}',   -- secret NAMES the adapter needs (never values)
  optional_secrets  text[] not null default '{}',   -- secret NAMES the adapter reads but can default (addition to the spec'd columns)
  docs_path         text,
  notes             text,
  updated_at        timestamptz not null default now(),
  constraint outlets_secret_names_check check (
    array_to_string(required_secrets || optional_secrets, ',') ~ '^([A-Z][A-Z0-9_]{2,80}(,|$))*$'
  )
);

comment on table outlet_sandbox.outlets is
  'Outlet registry for the sandbox admin sheet: setup status, checklist, and the NAMES of the secrets each adapter reads (values live in Vault as outlet_<NAME>). Service role only.';
comment on column outlet_sandbox.outlets.required_secrets is
  'Secret names the adapter needs. Together with optional_secrets this is the allow-list for set_outlet_secret / delete_outlet_secret. Names only — never values.';
comment on column outlet_sandbox.outlets.optional_secrets is
  'Secret names the adapter reads but has a default for (e.g. *_ENV, *_TARGET_COUNTRY). Also allow-listed for the secret functions.';

create or replace function outlet_sandbox.outlets_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists outlets_updated_at on outlet_sandbox.outlets;
create trigger outlets_updated_at before update on outlet_sandbox.outlets
for each row execute function outlet_sandbox.outlets_set_updated_at();

alter table outlet_sandbox.outlets enable row level security;
revoke all on outlet_sandbox.outlets from public, anon, authenticated;
revoke all on function outlet_sandbox.outlets_set_updated_at() from public, anon, authenticated;
grant select, insert, update, delete on outlet_sandbox.outlets to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Seed — one row per API connector (13) and manual outlet (8). Checklist steps and secret
--    names are taken from docs/outlets/<outlet>.md. ON CONFLICT DO NOTHING: re-running never
--    overwrites status/notes/checklist progress that has been edited since.
-- ─────────────────────────────────────────────────────────────────────────────
insert into outlet_sandbox.outlets (outlet, display_name, kind, checklist, required_secrets, optional_secrets, docs_path)
values
  ('google', 'Google Ads (YouTube / Demand Gen)', 'api', '[{"key": "step_1", "label": "Create a Google Ads manager (MCC) account and a client (ideally TEST) account", "done": false}, {"key": "step_2", "label": "Developer token: apply at Tools > API Center in the manager account (Test access works on test accounts; Basic for real ones)", "done": false}, {"key": "step_3", "label": "Google Cloud: enable the Google Ads API and YouTube Data API v3, create an OAuth client (id + secret)", "done": false}, {"key": "step_4", "label": "Mint a refresh token with BOTH scopes: adwords and youtube.upload (OAuth consent as the account user)", "done": false}, {"key": "step_5", "label": "Check the current API version in Google''s release notes and note it as GOOGLE_ADS_API_VERSION (e.g. v25)", "done": false}, {"key": "step_6", "label": "Paste the keys in this sheet", "done": false}, {"key": "step_7", "label": "Test connection (ping), then a validate_only create_demand_gen", "done": false}]'::jsonb, array['GOOGLE_ADS_API_VERSION','GOOGLE_ADS_DEVELOPER_TOKEN','GOOGLE_ADS_CLIENT_ID','GOOGLE_ADS_CLIENT_SECRET','GOOGLE_ADS_REFRESH_TOKEN','GOOGLE_ADS_LOGIN_CUSTOMER_ID','GOOGLE_ADS_CUSTOMER_ID']::text[], '{}'::text[], 'docs/outlets/google.md'),
  ('microsoft', 'Microsoft Advertising', 'api', '[{"key": "step_1", "label": "Create a Microsoft Advertising sandbox user + account (production later)", "done": false}, {"key": "step_2", "label": "Azure AD (Entra) app registration -> client id (and secret if confidential)", "done": false}, {"key": "step_3", "label": "OAuth consent (scope https://ads.microsoft.com/msads.manage offline_access) -> refresh token", "done": false}, {"key": "step_4", "label": "Note customer id and account id; developer token only needed for production (sandbox uses the universal token)", "done": false}, {"key": "step_5", "label": "Paste the keys in this sheet (MICROSOFT_ADS_ENV defaults to sandbox)", "done": false}, {"key": "step_6", "label": "Test connection (ping), then a validate_only create_campaign", "done": false}]'::jsonb, array['MICROSOFT_ADS_CLIENT_ID','MICROSOFT_ADS_REFRESH_TOKEN','MICROSOFT_ADS_CUSTOMER_ID','MICROSOFT_ADS_ACCOUNT_ID']::text[], array['MICROSOFT_ADS_ENV','MICROSOFT_ADS_DEVELOPER_TOKEN','MICROSOFT_ADS_CLIENT_SECRET','MICROSOFT_ADS_DEFAULT_CPC']::text[], 'docs/outlets/microsoft.md'),
  ('snapchat', 'Snapchat Ads', 'api', '[{"key": "step_1", "label": "Create a dedicated, unfunded Snapchat ad account in Business Manager (no sandbox exists)", "done": false}, {"key": "step_2", "label": "Business Manager > Business Details > OAuth Apps: create an app -> client id + secret", "done": false}, {"key": "step_3", "label": "Authorize with scope snapchat-marketing-api -> refresh token", "done": false}, {"key": "step_4", "label": "Note the ad account id (and Public Profile id if the creative needs one)", "done": false}, {"key": "step_5", "label": "Paste the keys in this sheet", "done": false}, {"key": "step_6", "label": "Test connection (ping), upload media, then a validate_only create_campaign", "done": false}]'::jsonb, array['SNAPCHAT_ADS_CLIENT_ID','SNAPCHAT_ADS_CLIENT_SECRET','SNAPCHAT_ADS_REFRESH_TOKEN','SNAPCHAT_ADS_AD_ACCOUNT_ID']::text[], array['SNAPCHAT_ADS_PROFILE_ID','SNAPCHAT_ADS_OBJECTIVE','SNAPCHAT_ADS_TARGET_COUNTRY']::text[], 'docs/outlets/snapchat.md'),
  ('openai', 'ChatGPT Ads', 'api', '[{"key": "step_1", "label": "Get a ChatGPT Ads (ads.openai.com) advertiser account approved", "done": false}, {"key": "step_2", "label": "Create an API key in the Ads Manager (confirm the path in OpenAI''s Ads help)", "done": false}, {"key": "step_3", "label": "Paste the key in this sheet", "done": false}, {"key": "step_4", "label": "Test connection (ping), then a validate_only create_campaign", "done": false}]'::jsonb, array['OPENAI_ADS_API_KEY']::text[], array['OPENAI_ADS_TARGET_COUNTRIES']::text[], 'docs/outlets/openai.md'),
  ('spotify', 'Spotify Ads (audio / video)', 'api', '[{"key": "step_1", "label": "Create a Spotify Ads Manager account and ad account", "done": false}, {"key": "step_2", "label": "Request Ads API access / create the Ads API application (client id + secret)", "done": false}, {"key": "step_3", "label": "Run the authorization-code flow once -> refresh token", "done": false}, {"key": "step_4", "label": "Note the ad account id", "done": false}, {"key": "step_5", "label": "Paste the keys in this sheet (SPOTIFY_ADS_ENV defaults to sandbox)", "done": false}, {"key": "step_6", "label": "Test connection (ping), then a validate_only create_campaign", "done": false}]'::jsonb, array['SPOTIFY_ADS_CLIENT_ID','SPOTIFY_ADS_CLIENT_SECRET','SPOTIFY_ADS_REFRESH_TOKEN','SPOTIFY_ADS_AD_ACCOUNT_ID']::text[], array['SPOTIFY_ADS_ENV','SPOTIFY_ADS_TARGET_COUNTRY']::text[], 'docs/outlets/spotify.md'),
  ('tiktok', 'TikTok Ads (incl. Spark Ads)', 'api', '[{"key": "step_1", "label": "Create a TikTok For Business account + Business Center and an advertiser account", "done": false}, {"key": "step_2", "label": "Register a developer app at business-api.tiktok.com and request the Marketing API scopes", "done": false}, {"key": "step_3", "label": "Wait for app review approval", "done": false}, {"key": "step_4", "label": "Authorize the app on your advertiser (auth_code) and exchange it for the long-lived access token", "done": false}, {"key": "step_5", "label": "For Spark Ads: have the creator authorize the post; note the identity id", "done": false}, {"key": "step_6", "label": "Paste the keys in this sheet", "done": false}, {"key": "step_7", "label": "Test connection (ping), then validate_only standard + Spark create_campaign", "done": false}]'::jsonb, array['TIKTOK_ADS_ACCESS_TOKEN','TIKTOK_ADS_ADVERTISER_ID']::text[], array['TIKTOK_ADS_IDENTITY_ID','TIKTOK_ADS_IDENTITY_TYPE']::text[], 'docs/outlets/tiktok.md'),
  ('reddit', 'Reddit Ads', 'api', '[{"key": "step_1", "label": "Create a Reddit Ads account (ad account id starts a2_)", "done": false}, {"key": "step_2", "label": "Create an OAuth app at reddit.com/prefs/apps (client id + secret)", "done": false}, {"key": "step_3", "label": "Ask Reddit Ads to allow-list the app for the Ads API (the API is allow-listed)", "done": false}, {"key": "step_4", "label": "Wait for approval", "done": false}, {"key": "step_5", "label": "Authorize as the ad-account user (duration=permanent) -> refresh token", "done": false}, {"key": "step_6", "label": "Paste the keys in this sheet", "done": false}, {"key": "step_7", "label": "Test connection (ping), then a validate_only create_campaign with extra.communities", "done": false}]'::jsonb, array['REDDIT_ADS_CLIENT_ID','REDDIT_ADS_CLIENT_SECRET','REDDIT_ADS_REFRESH_TOKEN','REDDIT_ADS_ACCOUNT_ID']::text[], array['REDDIT_ADS_USER_AGENT','REDDIT_ADS_PROFILE_ID']::text[], 'docs/outlets/reddit.md'),
  ('linkedin', 'LinkedIn Ads', 'api', '[{"key": "step_1", "label": "Create a LinkedIn Campaign Manager ad account and have a Company Page", "done": false}, {"key": "step_2", "label": "Create an app at linkedin.com/developers and link it to the Company Page (page admin verifies)", "done": false}, {"key": "step_3", "label": "Request the Advertising API product (Development tier)", "done": false}, {"key": "step_4", "label": "Wait for approval", "done": false}, {"key": "step_5", "label": "Authorize (scopes r_ads, rw_ads, r_ads_reporting, w_organization_social) -> tokens", "done": false}, {"key": "step_6", "label": "Pick the current LinkedIn-Version (YYYYMM) from the docs", "done": false}, {"key": "step_7", "label": "Paste the keys in this sheet", "done": false}, {"key": "step_8", "label": "Test connection (ping), then a validate_only create_campaign", "done": false}]'::jsonb, array['LINKEDIN_ADS_API_VERSION','LINKEDIN_ADS_CLIENT_ID','LINKEDIN_ADS_CLIENT_SECRET','LINKEDIN_ADS_REFRESH_TOKEN','LINKEDIN_ADS_AD_ACCOUNT_ID','LINKEDIN_ADS_ORGANIZATION_ID']::text[], array['LINKEDIN_ADS_CURRENCY','LINKEDIN_ADS_DEFAULT_CPC','LINKEDIN_ADS_LOCATION_URN']::text[], 'docs/outlets/linkedin.md'),
  ('pinterest', 'Pinterest Ads', 'api', '[{"key": "step_1", "label": "Create a Pinterest Business account and an ad account (sandbox ad account for testing)", "done": false}, {"key": "step_2", "label": "Connect an app at developers.pinterest.com (Trial access is immediate)", "done": false}, {"key": "step_3", "label": "Generate the sandbox access token in the portal (or run OAuth for the refresh-token flow)", "done": false}, {"key": "step_4", "label": "Later: apply for Standard access (app description + demo video)", "done": false}, {"key": "step_5", "label": "Paste the keys in this sheet: an access token OR app id + secret + refresh token (PINTEREST_ADS_ENV defaults to sandbox)", "done": false}, {"key": "step_6", "label": "Test connection (ping), then a validate_only create_campaign", "done": false}]'::jsonb, array['PINTEREST_ADS_AD_ACCOUNT_ID']::text[], array['PINTEREST_ADS_ENV','PINTEREST_ADS_ACCESS_TOKEN','PINTEREST_ADS_APP_ID','PINTEREST_ADS_APP_SECRET','PINTEREST_ADS_REFRESH_TOKEN','PINTEREST_ADS_BOARD_ID','PINTEREST_ADS_TARGET_COUNTRY']::text[], 'docs/outlets/pinterest.md'),
  ('x', 'X (Twitter) Ads', 'api', '[{"key": "step_1", "label": "Create an X Ads account (ads.x.com) with a funding instrument", "done": false}, {"key": "step_2", "label": "Create a developer app (developer.x.com)", "done": false}, {"key": "step_3", "label": "Apply for Ads API access and wait for approval (the app''s consumer key gets allow-listed)", "done": false}, {"key": "step_4", "label": "Generate OAuth 1.0a access token + secret as a user with Ad Manager permission", "done": false}, {"key": "step_5", "label": "Note the account id and funding instrument id", "done": false}, {"key": "step_6", "label": "Paste the keys in this sheet (X_ADS_ENV defaults to sandbox)", "done": false}, {"key": "step_7", "label": "Test connection (ping), then a validate_only create_campaign", "done": false}]'::jsonb, array['X_ADS_CONSUMER_KEY','X_ADS_CONSUMER_SECRET','X_ADS_ACCESS_TOKEN','X_ADS_ACCESS_TOKEN_SECRET','X_ADS_ACCOUNT_ID','X_ADS_FUNDING_INSTRUMENT_ID']::text[], array['X_ADS_ENV','X_ADS_API_VERSION','X_ADS_AS_USER_ID']::text[], 'docs/outlets/x.md'),
  ('amazon', 'Amazon Ads (Sponsored Brands)', 'api', '[{"key": "step_1", "label": "Have an Amazon Ads account with a profile in your marketplace and a registered brand (Brand Registry)", "done": false}, {"key": "step_2", "label": "Apply for Amazon Ads API access as a DIRECT ADVERTISER (advertising.amazon.com/API) - no sandbox exists", "done": false}, {"key": "step_3", "label": "Wait for approval", "done": false}, {"key": "step_4", "label": "Developer.amazon.com: create a Login with Amazon security profile (advertising::campaign_management) -> client id + secret", "done": false}, {"key": "step_5", "label": "Authorize -> refresh token; GET /v2/profiles for the profile id", "done": false}, {"key": "step_6", "label": "Note the brand entity id and a brand-logo asset id", "done": false}, {"key": "step_7", "label": "Paste the keys in this sheet (AMAZON_ADS_REGION defaults to na)", "done": false}, {"key": "step_8", "label": "Test connection (ping), then a validate_only create_campaign", "done": false}]'::jsonb, array['AMAZON_ADS_CLIENT_ID','AMAZON_ADS_CLIENT_SECRET','AMAZON_ADS_REFRESH_TOKEN','AMAZON_ADS_PROFILE_ID']::text[], array['AMAZON_ADS_REGION','AMAZON_ADS_BRAND_ENTITY_ID','AMAZON_ADS_BRAND_LOGO_ASSET_ID']::text[], 'docs/outlets/amazon.md'),
  ('taboola', 'Taboola (native)', 'api', '[{"key": "step_1", "label": "Have an active Taboola advertiser account (via your Taboola account manager)", "done": false}, {"key": "step_2", "label": "Ask the account manager for Backstage API credentials (client id + secret, client-credentials flow)", "done": false}, {"key": "step_3", "label": "Note the account id used in the API path", "done": false}, {"key": "step_4", "label": "Paste the keys in this sheet", "done": false}, {"key": "step_5", "label": "Test connection (ping), then a validate_only create_campaign", "done": false}]'::jsonb, array['TABOOLA_ADS_CLIENT_ID','TABOOLA_ADS_CLIENT_SECRET','TABOOLA_ADS_ACCOUNT_ID']::text[], array['TABOOLA_ADS_DEFAULT_CPC']::text[], 'docs/outlets/taboola.md'),
  ('adquick', 'AdQuick (DOOH / billboards)', 'api', '[{"key": "step_1", "label": "Contact AdQuick (partnerships / your rep) for Partner API access", "done": false}, {"key": "step_2", "label": "Receive the partner token", "done": false}, {"key": "step_3", "label": "Paste the token in this sheet", "done": false}, {"key": "step_4", "label": "Test connection (ping) - paths are unverified, expect to adjust", "done": false}, {"key": "step_5", "label": "validate_only create_campaign with extra.start_date / end_date", "done": false}]'::jsonb, array['ADQUICK_PARTNER_TOKEN']::text[], '{}'::text[], 'docs/outlets/adquick.md'),
  ('audiogo', 'AudioGO', 'manual', '[{"key": "step_1", "label": "Create the account on audiogo.com", "done": false}, {"key": "step_2", "label": "Add a payment method / complete any verification", "done": false}, {"key": "step_3", "label": "Book a first test campaign (minimum budget: $250)", "done": false}, {"key": "step_4", "label": "Log it in sandbox-manual (create) with profile_id / hubspot_deal_id", "done": false}, {"key": "step_5", "label": "Add results as they come in (update results)", "done": false}]'::jsonb, '{}'::text[], '{}'::text[], 'docs/outlets/manual.md'),
  ('blip', 'Blip Billboards', 'manual', '[{"key": "step_1", "label": "Create the account on blipbillboards.com", "done": false}, {"key": "step_2", "label": "Add a payment method / complete any verification", "done": false}, {"key": "step_3", "label": "Book a first test campaign (minimum budget: no minimum advertised)", "done": false}, {"key": "step_4", "label": "Log it in sandbox-manual (create) with profile_id / hubspot_deal_id", "done": false}, {"key": "step_5", "label": "Add results as they come in (update results)", "done": false}]'::jsonb, '{}'::text[], '{}'::text[], 'docs/outlets/manual.md'),
  ('acast', 'Acast', 'manual', '[{"key": "step_1", "label": "Create the account on acast.com (self-serve)", "done": false}, {"key": "step_2", "label": "Add a payment method / complete any verification", "done": false}, {"key": "step_3", "label": "Book a first test campaign (minimum budget: $250, unconfirmed)", "done": false}, {"key": "step_4", "label": "Log it in sandbox-manual (create) with profile_id / hubspot_deal_id", "done": false}, {"key": "step_5", "label": "Add results as they come in (update results)", "done": false}]'::jsonb, '{}'::text[], '{}'::text[], 'docs/outlets/manual.md'),
  ('iheart_adbuilder', 'iHeart AdBuilder', 'manual', '[{"key": "step_1", "label": "Create the account on iHeartMedia advertise pages", "done": false}, {"key": "step_2", "label": "Add a payment method / complete any verification", "done": false}, {"key": "step_3", "label": "Book a first test campaign (minimum budget: $250, unconfirmed)", "done": false}, {"key": "step_4", "label": "Log it in sandbox-manual (create) with profile_id / hubspot_deal_id", "done": false}, {"key": "step_5", "label": "Add results as they come in (update results)", "done": false}]'::jsonb, '{}'::text[], '{}'::text[], 'docs/outlets/manual.md'),
  ('bandsintown', 'Bandsintown', 'manual', '[{"key": "step_1", "label": "Create the account on artist.bandsintown.com (Ad Manager)", "done": false}, {"key": "step_2", "label": "Add a payment method / complete any verification", "done": false}, {"key": "step_3", "label": "Book a first test campaign (minimum budget: $50 posts / $150 emails)", "done": false}, {"key": "step_4", "label": "Log it in sandbox-manual (create) with profile_id / hubspot_deal_id", "done": false}, {"key": "step_5", "label": "Add results as they come in (update results)", "done": false}]'::jsonb, '{}'::text[], '{}'::text[], 'docs/outlets/manual.md'),
  ('audiomack_sponsored', 'Audiomack Sponsored Songs', 'manual', '[{"key": "step_1", "label": "Create the account on Audiomack Creator Dashboard", "done": false}, {"key": "step_2", "label": "Add a payment method / complete any verification", "done": false}, {"key": "step_3", "label": "Book a first test campaign (minimum budget: ~$1-10, unconfirmed)", "done": false}, {"key": "step_4", "label": "Log it in sandbox-manual (create) with profile_id / hubspot_deal_id", "done": false}, {"key": "step_5", "label": "Add results as they come in (update results)", "done": false}]'::jsonb, '{}'::text[], '{}'::text[], 'docs/outlets/manual.md'),
  ('soundcloud_promote', 'SoundCloud Promote', 'manual', '[{"key": "step_1", "label": "Create the account on SoundCloud for Artists (Artist Pro)", "done": false}, {"key": "step_2", "label": "Add a payment method / complete any verification", "done": false}, {"key": "step_3", "label": "Book a first test campaign (minimum budget: $25)", "done": false}, {"key": "step_4", "label": "Log it in sandbox-manual (create) with profile_id / hubspot_deal_id", "done": false}, {"key": "step_5", "label": "Add results as they come in (update results)", "done": false}]'::jsonb, '{}'::text[], '{}'::text[], 'docs/outlets/manual.md'),
  ('applovin', 'AppLovin Ads', 'manual', '[{"key": "step_1", "label": "Create the account on AppLovin Ads / Axon ads manager", "done": false}, {"key": "step_2", "label": "Add a payment method / complete any verification", "done": false}, {"key": "step_3", "label": "Book a first test campaign (minimum budget: none stated)", "done": false}, {"key": "step_4", "label": "Log it in sandbox-manual (create) with profile_id / hubspot_deal_id", "done": false}, {"key": "step_5", "label": "Add results as they come in (update results)", "done": false}]'::jsonb, '{}'::text[], '{}'::text[], 'docs/outlets/manual.md')
on conflict (outlet) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Vault-backed secrets. Stored in vault.secrets as outlet_<NAME> (e.g. outlet_TIKTOK_ADS_ACCESS_TOKEN).
--    Only names listed in some outlet's required_secrets / optional_secrets are accepted.
-- ─────────────────────────────────────────────────────────────────────────────

-- Internal allow-list check (also used by the functions below).
create or replace function outlet_sandbox.outlet_secret_allowed(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_name is not null and exists (
    select 1 from outlet_sandbox.outlets o
    where p_name = any (o.required_secrets) or p_name = any (o.optional_secrets)
  );
$$;

-- One secret's value (allow-listed names only; null if unset).
create or replace function outlet_sandbox.get_outlet_secret(p_name text)
returns text
language sql stable security definer set search_path = ''
as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where outlet_sandbox.outlet_secret_allowed(p_name)
    and ds.name = 'outlet_' || p_name
  limit 1;
$$;

-- All set secrets of one outlet in a single call — used by the adapters' config loading.
create or replace function outlet_sandbox.get_outlet_secrets(p_outlet text)
returns table (name text, secret text)
language sql stable security definer set search_path = ''
as $$
  select n.n, ds.decrypted_secret
  from outlet_sandbox.outlets o
  cross join lateral unnest(o.required_secrets || o.optional_secrets) as n(n)
  join vault.decrypted_secrets ds on ds.name = 'outlet_' || n.n
  where o.outlet = p_outlet;
$$;

-- Presence of each of an outlet's secrets, WITHOUT the value: only "set" and the last 4 characters
-- (and only when the value is long enough that 4 characters reveal little).
create or replace function outlet_sandbox.outlet_secret_status(p_outlet text)
returns table (name text, required boolean, is_set boolean, last4 text)
language sql stable security definer set search_path = ''
as $$
  select n.n,
         n.required,
         ds.decrypted_secret is not null,
         case when length(ds.decrypted_secret) >= 12 then right(ds.decrypted_secret, 4) end
  from outlet_sandbox.outlets o
  cross join lateral (
    select x as n, true as required from unnest(o.required_secrets) as x
    union all
    select x, false from unnest(o.optional_secrets) as x
  ) n
  left join vault.decrypted_secrets ds on ds.name = 'outlet_' || n.n
  where o.outlet = p_outlet;
$$;

-- Create or replace a secret.
create or replace function outlet_sandbox.set_outlet_secret(p_name text, p_value text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := 'outlet_' || p_name;
  v_id uuid;
begin
  if not outlet_sandbox.outlet_secret_allowed(p_name) then
    raise exception 'secret name % is not listed in any outlet''s required_secrets/optional_secrets', p_name using errcode = '42501';
  end if;
  if p_value is null or length(btrim(p_value)) = 0 or length(p_value) > 8192 then
    raise exception 'secret value must be 1-8192 characters' using errcode = '22023';
  end if;

  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    perform vault.create_secret(p_value, v_name, 'Outlet sandbox secret ' || p_name);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end;
$$;

-- Delete a secret; returns whether one existed.
create or replace function outlet_sandbox.delete_outlet_secret(p_name text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if not outlet_sandbox.outlet_secret_allowed(p_name) then
    raise exception 'secret name % is not listed in any outlet''s required_secrets/optional_secrets', p_name using errcode = '42501';
  end if;
  delete from vault.secrets where name = 'outlet_' || p_name;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- Service role only.
revoke all on function outlet_sandbox.outlet_secret_allowed(text)   from public, anon, authenticated;
revoke all on function outlet_sandbox.get_outlet_secret(text)       from public, anon, authenticated;
revoke all on function outlet_sandbox.get_outlet_secrets(text)      from public, anon, authenticated;
revoke all on function outlet_sandbox.outlet_secret_status(text)    from public, anon, authenticated;
revoke all on function outlet_sandbox.set_outlet_secret(text, text) from public, anon, authenticated;
revoke all on function outlet_sandbox.delete_outlet_secret(text)    from public, anon, authenticated;
grant execute on function outlet_sandbox.outlet_secret_allowed(text)   to service_role;
grant execute on function outlet_sandbox.get_outlet_secret(text)       to service_role;
grant execute on function outlet_sandbox.get_outlet_secrets(text)      to service_role;
grant execute on function outlet_sandbox.outlet_secret_status(text)    to service_role;
grant execute on function outlet_sandbox.set_outlet_secret(text, text) to service_role;
grant execute on function outlet_sandbox.delete_outlet_secret(text)    to service_role;
grant usage on schema outlet_sandbox to service_role;
