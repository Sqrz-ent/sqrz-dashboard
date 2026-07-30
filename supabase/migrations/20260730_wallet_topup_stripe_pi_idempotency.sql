-- Part 2: wallet-topup idempotency by Stripe payment_intent.
-- Applied to project fmjefvdtnmgdfauedpmg via apply_migration on 2026-07-30.

-- UNIQUE on stripe_payment_intent_id (Postgres treats NULLs as distinct, so
-- non-Stripe-linked entries like allocations/deallocations can stay NULL freely).
alter table public.wallet_ledger_entries
  add constraint wallet_ledger_entries_stripe_pi_key unique (stripe_payment_intent_id);

-- record_wallet_topup: same 5-arg signature/behaviour, but the topup insert is now
-- ON CONFLICT DO NOTHING on the payment_intent. A duplicate webhook delivery (same
-- PI) becomes a safe no-op returning NULL — no error, no double credit, no
-- duplicate management-fee row.
create or replace function public.record_wallet_topup(
  p_profile_id uuid,
  p_amount_cents bigint,
  p_source text,
  p_stripe_payment_intent_id text,
  p_fee_exempt boolean default false
)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ledger_id bigint;
  -- Flat management fee on standalone (non-fee-exempt) top-ups. grow_clients is
  -- dormant; to make this ops-configurable later, read app_config instead.
  v_fee_pct constant numeric := 15.0;
  v_fee_cents bigint;
begin
  insert into wallet_ledger_entries
    (profile_id, amount_cents, entry_type, source, stripe_payment_intent_id, fee_exempt)
  values
    (p_profile_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id, p_fee_exempt)
  on conflict (stripe_payment_intent_id) do nothing
  returning id into v_ledger_id;

  -- Duplicate payment_intent → already credited. Idempotent no-op (skip fee too).
  if v_ledger_id is null then
    return null;
  end if;

  if not p_fee_exempt then
    v_fee_cents := round(p_amount_cents * v_fee_pct / 100.0);
    insert into management_fee_charges
      (profile_id, wallet_ledger_entry_id, amount_cents, status)
    values
      (p_profile_id, v_ledger_id, v_fee_cents, 'pending');
  end if;

  return v_ledger_id;
end;
$function$;
