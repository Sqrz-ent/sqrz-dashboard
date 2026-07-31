-- Extend the existing live/test Stripe-mode pattern (boost_campaigns/subscriptions/
-- partner_earnings already carry stripe_mode — see
-- 20260513_add_parallel_stripe_test_mode.sql) to the wallet ledger. iOS wallet
-- top-up / Start Campaign checkout are being forced onto Stripe test mode
-- regardless of profile.stripe_beta_test_mode (web is untouched, stays live) —
-- every row that produces must be distinguishable from real money at the row
-- level, never ambiguous which is which.
-- Applied via apply_migration on 2026-07-31.

alter table public.wallet_ledger_entries
  add column if not exists stripe_mode text not null default 'live';

alter table public.management_fee_charges
  add column if not exists stripe_mode text not null default 'live';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wallet_ledger_entries_stripe_mode_check'
  ) then
    alter table public.wallet_ledger_entries
      add constraint wallet_ledger_entries_stripe_mode_check
      check (stripe_mode in ('live', 'test'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'management_fee_charges_stripe_mode_check'
  ) then
    alter table public.management_fee_charges
      add constraint management_fee_charges_stripe_mode_check
      check (stripe_mode in ('live', 'test'));
  end if;
end
$$;

comment on column public.wallet_ledger_entries.stripe_mode is
  'Whether this entry originated from a live or test-mode Stripe transaction. iOS wallet top-up / Start Campaign checkout are currently forced to test mode regardless of profile.stripe_beta_test_mode — see api/wallet/topup.tsx + api/campaigns/checkout.tsx.';

comment on column public.management_fee_charges.stripe_mode is
  'Whether the underlying top-up was a live or test-mode Stripe transaction (mirrors the linked wallet_ledger_entries.stripe_mode).';

-- record_wallet_topup gains p_stripe_mode. Recreated (not CREATE OR REPLACE)
-- because adding a parameter changes the signature — same approach as the prior
-- p_fee_exempt addition (20260730_unify_wallet_funding_fee_exempt.sql).
drop function if exists public.record_wallet_topup(uuid, bigint, text, text, boolean);

create function public.record_wallet_topup(
  p_profile_id uuid,
  p_amount_cents bigint,
  p_source text,
  p_stripe_payment_intent_id text,
  p_fee_exempt boolean default false,
  p_stripe_mode text default 'live'
)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ledger_id bigint;
  -- Flat management fee on standalone top-ups. Was a per-client grow_clients rate;
  -- grow_clients is now dormant (see root CLAUDE.md), so this is a flat, unconditional
  -- 15%. To make it ops-configurable later, read app_config instead of this constant.
  v_fee_pct constant numeric := 15.0;
  v_fee_cents bigint;
  v_mode text := case when p_stripe_mode in ('live', 'test') then p_stripe_mode else 'live' end;
begin
  insert into wallet_ledger_entries
    (profile_id, amount_cents, entry_type, source, stripe_payment_intent_id, fee_exempt, stripe_mode)
  values
    (p_profile_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id, p_fee_exempt, v_mode)
  returning id into v_ledger_id;

  -- Campaign-start budgets are fee-exempt (fee collected inline at campaign checkout)
  -- — no separate management-fee charge. Standalone top-ups incur the flat 15% fee as
  -- a separate financial event.
  if not p_fee_exempt then
    v_fee_cents := round(p_amount_cents * v_fee_pct / 100.0);
    insert into management_fee_charges
      (profile_id, wallet_ledger_entry_id, amount_cents, status, stripe_mode)
    values
      (p_profile_id, v_ledger_id, v_fee_cents, 'pending', v_mode);
  end if;

  return v_ledger_id;
end;
$function$;

revoke execute on function public.record_wallet_topup(uuid, bigint, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.record_wallet_topup(uuid, bigint, text, text, boolean, text) to service_role;

-- record_campaign_start_funding gains p_stripe_mode too, threaded through to
-- record_wallet_topup AND the allocation-side ledger insert it makes directly.
drop function if exists public.record_campaign_start_funding(uuid, uuid, bigint, text, text);

create function public.record_campaign_start_funding(
  p_profile_id uuid,
  p_campaign_id uuid,
  p_amount_cents bigint,
  p_source text,
  p_stripe_payment_intent_id text,
  p_stripe_mode text default 'live'
)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ledger_id bigint;
  v_mode text := case when p_stripe_mode in ('live', 'test') then p_stripe_mode else 'live' end;
begin
  v_ledger_id := record_wallet_topup(p_profile_id, p_amount_cents, p_source, p_stripe_payment_intent_id, true, v_mode);
  if v_ledger_id is null then
    return null; -- duplicate webhook — original tx already funded + allocated
  end if;

  insert into campaign_budgets (campaign_id) values (p_campaign_id) on conflict (campaign_id) do nothing;
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
    values (p_profile_id, -p_amount_cents, 'allocation', p_source, p_campaign_id, v_mode);

  return v_ledger_id;
end;
$function$;

revoke execute on function public.record_campaign_start_funding(uuid,uuid,bigint,text,text,text) from public, anon, authenticated;
grant execute on function public.record_campaign_start_funding(uuid,uuid,bigint,text,text,text) to service_role;
