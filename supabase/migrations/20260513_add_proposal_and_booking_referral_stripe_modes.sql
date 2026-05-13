alter table public.booking_proposals
  add column if not exists stripe_mode text not null default 'live';

alter table public.booking_referral_earnings
  add column if not exists stripe_mode text not null default 'live';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'booking_proposals_stripe_mode_check'
  ) then
    alter table public.booking_proposals
      add constraint booking_proposals_stripe_mode_check
      check (stripe_mode in ('live', 'test'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'booking_referral_earnings_stripe_mode_check'
  ) then
    alter table public.booking_referral_earnings
      add constraint booking_referral_earnings_stripe_mode_check
      check (stripe_mode in ('live', 'test'));
  end if;
end $$;

create unique index if not exists booking_referral_earnings_booking_id_stripe_mode_key
  on public.booking_referral_earnings (booking_id, stripe_mode);

comment on column public.booking_proposals.stripe_mode is
  'Frozen Stripe environment for this proposal payment flow: live or test.';

comment on column public.booking_referral_earnings.stripe_mode is
  'Whether this booking referral commission came from live or test Stripe.';
