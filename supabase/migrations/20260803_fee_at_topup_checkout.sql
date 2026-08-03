-- Commission moves back off allocation and onto top-up checkout (2026-08-03) —
-- superseding the 2026-08-01 allocation-fee-model pivot. Stripe Checkout only
-- ever handles card payments (wire transfers are a separate, off-platform
-- process), so this only needs the flat 15% standard rate — no per-profile
-- tier lookup. allocate_campaign_budget goes back to a pure wallet→campaign
-- move with no commission attached; record_wallet_topup credits the wallet AND
-- records the 15% fee (as management_fee_charges, linked to the topup's own
-- ledger entry — a separate financial event that never touches the wallet
-- balance, so no new wallet_ledger_entries.entry_type is needed).

create or replace function public.record_wallet_topup(
  p_profile_id uuid,
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
  v_mode text := case when p_stripe_mode in ('live','test') then p_stripe_mode else 'live' end;
  v_fee_cents bigint;
begin
  -- 1. Wallet credit — full amount (pure ad spend; fee is a separate charge).
  insert into wallet_ledger_entries
    (profile_id, amount_cents, entry_type, source, stripe_payment_intent_id, stripe_mode)
  values
    (p_profile_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id, v_mode)
  on conflict (stripe_payment_intent_id) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    return null; -- duplicate payment_intent — safe idempotent no-op, no fee row either
  end if;

  -- 2. SQRZ fee — flat 15%, charged in the SAME Checkout session (see
  --    createWalletTopupCheckoutSession) as its own line item. Recorded as
  --    revenue only; management_fee_charges is decoupled from ad_spend_wallets,
  --    so this never affects the wallet balance.
  v_fee_cents := round(p_amount_cents * 0.15);
  insert into management_fee_charges (profile_id, wallet_ledger_entry_id, amount_cents, status, stripe_mode)
    values (p_profile_id, v_ledger_id, v_fee_cents, 'pending', v_mode);

  return v_ledger_id;
end;
$function$;

create or replace function public.allocate_campaign_budget(
  p_campaign_id uuid,
  p_amount_cents bigint,
  p_source text default 'ios'::text,
  p_stripe_mode text default 'live'::text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
  v_balance bigint;
  v_status text;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
  v_mode text := case when p_stripe_mode in ('live','test') then p_stripe_mode else 'live' end;
begin
  -- $10 minimum (pills all clear it; custom amounts must be >= $10). Enforced
  -- here too, not just client-side.
  if p_amount_cents < 1000 then
    raise exception 'minimum allocation is $10';
  end if;
  select id into v_profile_id from profiles where user_id = auth.uid();
  if v_profile_id is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from boost_campaigns where id = p_campaign_id and profile_id = v_profile_id) then
    raise exception 'campaign not found';
  end if;
  select balance_cents into v_balance from ad_spend_wallets where profile_id = v_profile_id;
  if coalesce(v_balance, 0) < p_amount_cents then raise exception 'insufficient wallet balance'; end if;

  insert into campaign_budgets (campaign_id) values (p_campaign_id) on conflict (campaign_id) do nothing;
  select status into v_status from campaign_budgets where campaign_id = p_campaign_id;
  if v_status = 'exhausted' then
    raise exception 'campaign is exhausted — reactivate before allocating';
  end if;

  -- Move the amount from wallet → campaign. No commission here anymore — the fee
  -- is charged once, at top-up (see record_wallet_topup). The apply_wallet_ledger_entry
  -- trigger decrements the wallet balance and increments campaign_budgets.allocated_cents.
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
    values (v_profile_id, -p_amount_cents, 'allocation', v_src, p_campaign_id, v_mode);
end;
$function$;

comment on column public.management_fee_charges.wallet_ledger_entry_id is
  'The wallet_ledger_entries row this commission attaches to. As of the fee-at-topup model (2026-08-03, superseding the 2026-08-01 allocation-fee pivot) that is the TOP-UP entry (entry_type=''topup'') that funded it — allocation no longer carries a commission.';
