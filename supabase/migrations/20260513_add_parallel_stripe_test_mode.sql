alter table public.profiles
  add column if not exists stripe_connect_id_test text,
  add column if not exists stripe_connect_status_test text,
  add column if not exists stripe_customer_id_test text,
  add column if not exists stripe_beta_test_mode boolean not null default false;

alter table public.booking_wallets
  add column if not exists stripe_mode text not null default 'live';

alter table public.boost_campaigns
  add column if not exists stripe_mode text not null default 'live';

alter table public.partner_earnings
  add column if not exists stripe_mode text not null default 'live';

alter table public.subscriptions
  add column if not exists stripe_mode text not null default 'live';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'booking_wallets_stripe_mode_check'
  ) then
    alter table public.booking_wallets
      add constraint booking_wallets_stripe_mode_check
      check (stripe_mode in ('live', 'test'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'boost_campaigns_stripe_mode_check'
  ) then
    alter table public.boost_campaigns
      add constraint boost_campaigns_stripe_mode_check
      check (stripe_mode in ('live', 'test'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'partner_earnings_stripe_mode_check'
  ) then
    alter table public.partner_earnings
      add constraint partner_earnings_stripe_mode_check
      check (stripe_mode in ('live', 'test'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'subscriptions_stripe_mode_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_stripe_mode_check
      check (stripe_mode in ('live', 'test'));
  end if;
end
$$;

comment on column public.profiles.stripe_connect_id_test is
  'Stripe Connect account id for beta/test-mode onboarding.';

comment on column public.profiles.stripe_connect_status_test is
  'Status of the beta/test Stripe Connect account.';

comment on column public.profiles.stripe_customer_id_test is
  'Stripe customer id in test mode for beta-only parallel checkout flows.';

comment on column public.profiles.stripe_beta_test_mode is
  'Beta-only flag to opt into clearly marked Stripe test flows while live mode remains active.';

comment on column public.booking_wallets.stripe_mode is
  'Whether the wallet originated from live or test Stripe flows.';

comment on column public.boost_campaigns.stripe_mode is
  'Whether the campaign payment flow ran against live or test Stripe.';

comment on column public.partner_earnings.stripe_mode is
  'Whether the referral/revenue-share earning came from live or test Stripe events.';

comment on column public.subscriptions.stripe_mode is
  'Whether the subscription record came from live or test Stripe.';
