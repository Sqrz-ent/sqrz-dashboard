-- Wallet top-up fee: 15% → 7% (2026-10-25). Campaign package templates replaced
-- the manual setup the old rate paid for. 7% covers Stripe (2.9% + $0.30, up to
-- ~4.9% + $0.30 on international/converted cards) on every allowed amount
-- ($50–$500) and leaves a small margin. Must match SQRZ_TOPUP_FEE_PCT in
-- app/lib/walletPayments.server.ts (what Stripe charges) and the iOS
-- WalletTopupCard.topupFeePct (what the app shows). Body otherwise unchanged.
create or replace function public.record_wallet_topup(p_profile_id uuid, p_amount_cents bigint, p_source text, p_stripe_payment_intent_id text, p_stripe_mode text default 'live'::text)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_account_id uuid;
  v_ledger_id bigint;
  v_mode text := case when p_stripe_mode in ('live','test') then p_stripe_mode else 'live' end;
  v_fee_cents bigint;
begin
  select account_id into v_account_id from profiles where id = p_profile_id;
  if v_account_id is null then
    raise exception 'profile has no account';
  end if;

  insert into wallet_ledger_entries
    (profile_id, account_id, amount_cents, entry_type, source, stripe_payment_intent_id, stripe_mode)
  values
    (p_profile_id, v_account_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id, v_mode)
  on conflict (stripe_payment_intent_id) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    return null;
  end if;

  v_fee_cents := round(p_amount_cents * 0.07);
  insert into management_fee_charges (profile_id, wallet_ledger_entry_id, amount_cents, status, stripe_mode)
    values (p_profile_id, v_ledger_id, v_fee_cents, 'pending', v_mode);

  return v_ledger_id;
end;
$function$;
