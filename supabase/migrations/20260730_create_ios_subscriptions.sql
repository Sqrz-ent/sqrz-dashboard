-- SQRZ Companion (iOS-only subscription) — groundwork tables + RPC.
-- The subscription is a feature-level entitlement layered on top of the free,
-- universal SQRZ account — never an account-level gate. Boost campaign payments
-- (Stripe) are unrelated and untouched.

-- ── ios_subscriptions ─────────────────────────────────────────────────────────
create table ios_subscriptions (
  id bigint generated always as identity primary key,
  profile_id uuid references profiles(id) on delete cascade not null,
  product_id text not null,
  -- Apple's stable identifier across renewals — the dedup/upsert key.
  -- latest_transaction_id changes on every renewal.
  original_transaction_id text unique not null,
  latest_transaction_id text,
  status text not null check (status in (
    'active', 'expired', 'in_grace_period', 'in_billing_retry',
    'revoked', 'refunded'
  )),
  environment text not null check (environment in ('sandbox', 'production')),
  current_period_expires_at timestamptz,
  auto_renew_status boolean default true,
  auto_renew_product_id text,
  cancellation_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_ios_subscriptions_profile_id on ios_subscriptions(profile_id);
create index idx_ios_subscriptions_status on ios_subscriptions(status);

create trigger ios_subscriptions_updated_at
  before update on ios_subscriptions
  for each row execute function handle_updated_at();

alter table ios_subscriptions enable row level security;

-- Owner can read their own subscription rows. NOTE: profiles.id ≠ auth.users.id
-- (Critical ID Rules) — the profile is resolved via the existing SECURITY
-- DEFINER helper, not compared to auth.uid() directly.
create policy "ios_subscriptions_owner_read"
  on ios_subscriptions for select
  using (profile_id = get_profile_id_for_user(auth.uid()));

-- No insert/update/delete policies for the authenticated role — all writes go
-- through the apple-subscription-webhook edge function via the service role.

-- ── apple_webhook_events ──────────────────────────────────────────────────────
-- Raw log of every App Store Server Notification received, including types we
-- don't act on — App Review / Apple support sometimes ask "did you receive
-- event X", and raw logs answer that. Service-role only (RLS on, no policies).
create table apple_webhook_events (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  notification_type text,
  subtype text,
  notification_uuid text,
  original_transaction_id text,
  environment text,
  payload jsonb,
  processed boolean default false,
  error text
);

create index idx_apple_webhook_events_original_txn
  on apple_webhook_events(original_transaction_id);

alter table apple_webhook_events enable row level security;

-- ── app_config ────────────────────────────────────────────────────────────────
-- Minimal remote feature-flag store, read by the iOS client at launch. World-
-- readable (flags are not secrets); writes are service-role only.
create table app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

alter table app_config enable row level security;

create policy "app_config_public_read" on app_config for select using (true);

-- Paywall stays dark until we explicitly launch: flag defaults to false.
insert into app_config (key, value)
values ('companion_subscription_enabled', 'false'::jsonb);

-- ── Entitlement-check RPC ─────────────────────────────────────────────────────
-- The one stable surface the iOS client (and future feature gates) should call —
-- never query ios_subscriptions directly, so the table schema can evolve.
-- Deliberately auth.uid()-scoped with NO profile_id argument: a SECURITY DEFINER
-- function taking an arbitrary profile_id would let any caller read anyone's
-- subscription status.
create or replace function get_companion_subscription_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'active',
          s.status in ('active', 'in_grace_period')
          and (s.current_period_expires_at is null or s.current_period_expires_at > now()),
        'status', s.status,
        'expires_at', s.current_period_expires_at,
        'product_id', s.product_id
      )
      from ios_subscriptions s
      where s.profile_id = get_profile_id_for_user(auth.uid())
      order by s.current_period_expires_at desc nulls last
      limit 1
    ),
    jsonb_build_object('active', false, 'status', null, 'expires_at', null, 'product_id', null)
  );
$$;
