-- Unify campaign-start budget + standalone wallet top-up into one ad_spend_wallets
-- balance. Distinguish the two funding paths on wallet_ledger_entries, and drop the
-- dormant grow_clients per-client fee read in favour of a flat 15% management fee
-- that applies ONLY to standalone top-ups (campaign-start budgets are fee_exempt —
-- their fee is collected inline at campaign checkout).
--
-- Applied to project fmjefvdtnmgdfauedpmg via apply_migration on 2026-07-30.

alter table public.wallet_ledger_entries
  add column if not exists fee_exempt boolean not null default false;

comment on column public.wallet_ledger_entries.fee_exempt is
  'true = campaign-start budget credit (fee collected inline at campaign checkout; no separate management_fee_charges row). false = standalone top-up (a 15% management_fee_charges row is created).';

-- record_wallet_topup gains p_fee_exempt. Recreated (not CREATE OR REPLACE) because
-- adding a parameter changes the signature. Still service_role-only.
drop function if exists public.record_wallet_topup(uuid, bigint, text, text);

create function public.record_wallet_topup(
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
  -- Flat management fee on standalone top-ups. Was a per-client grow_clients rate;
  -- grow_clients is now dormant (see root CLAUDE.md), so this is a flat, unconditional
  -- 15%. To make it ops-configurable later, read app_config instead of this constant.
  v_fee_pct constant numeric := 15.0;
  v_fee_cents bigint;
begin
  insert into wallet_ledger_entries
    (profile_id, amount_cents, entry_type, source, stripe_payment_intent_id, fee_exempt)
  values
    (p_profile_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id, p_fee_exempt)
  returning id into v_ledger_id;

  -- Campaign-start budgets are fee-exempt (fee collected inline at campaign checkout)
  -- — no separate management-fee charge. Standalone top-ups incur the flat 15% fee as
  -- a separate financial event.
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

revoke execute on function public.record_wallet_topup(uuid, bigint, text, text, boolean) from public, anon, authenticated;
grant execute on function public.record_wallet_topup(uuid, bigint, text, text, boolean) to service_role;
