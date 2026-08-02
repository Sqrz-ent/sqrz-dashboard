-- Allow custom allocation amounts (not just the $25/$50/$100/$150 pills), with a
-- flat $10 (1000-cent) floor. Backs the iOS pipeline-card "Allocate Budget" custom
-- amount option; the floor is a placeholder for today's operational reality (Meta
-- campaign creation isn't automated yet, so tiny campaigns carry manual overhead)
-- and is expected to loosen once creation is automated. Everything else about the
-- function is unchanged (ownership, balance, lazy budget-row create, exhausted
-- guard, tiered commission). CREATE OR REPLACE preserves the existing grant to
-- authenticated.
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
  v_rate numeric;
  v_ledger_id bigint;
  v_fee_cents bigint;
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

  -- Commission rate from the profile's tier; default 15% when there's no row.
  select fee_percentage into v_rate from client_fee_tiers where profile_id = v_profile_id;
  v_rate := coalesce(v_rate, 15.0);

  -- Move the amount from wallet → campaign. The apply_wallet_ledger_entry trigger
  -- decrements the wallet balance and increments campaign_budgets.allocated_cents.
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
    values (v_profile_id, -p_amount_cents, 'allocation', v_src, p_campaign_id, v_mode)
    returning id into v_ledger_id;

  -- Commission is a SEPARATE financial event, never netted from the wallet — the
  -- full amount funds the campaign. Linked to THIS allocation entry (not a top-up).
  v_fee_cents := round(p_amount_cents * v_rate / 100.0);
  insert into management_fee_charges (profile_id, wallet_ledger_entry_id, amount_cents, status, stripe_mode)
    values (v_profile_id, v_ledger_id, v_fee_cents, 'pending', v_mode);
end;
$function$;
