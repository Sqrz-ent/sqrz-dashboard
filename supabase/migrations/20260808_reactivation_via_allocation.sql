-- Reactivation-via-allocation + payment-vestige cleanup (2026-08-08)
--
-- Follows the $25 setup-fee and $10 reactivation-fee removals. Finishes the job
-- on the DB side:
--
-- 1. boost_campaigns.requires_payment default flips true -> false. It was the
--    payment-era default; with no payment flow left, a row inserted without an
--    explicit value must never come back as "requires payment" (this default,
--    plus the "Pending Payment" status label, was the root cause of campaigns
--    rendering a payment-pending state). The column is KEPT, not dropped — the
--    deprecated Stripe webhook branches still compile against sibling stripe_*
--    columns; a full column drop is a separate, later pass. It is now written by
--    nothing (iOS stopped setting it), so every new row simply takes false.
--
-- 2. allocate_campaign_budget no longer BLOCKS allocation to an exhausted
--    campaign — it REACTIVATES it as part of the same funded, atomic
--    transaction. Funding is now the single gate that brings a campaign back,
--    replacing the standalone "reactivate first" step (which used to cost $10).
--    On a successful allocation:
--      - campaign_budgets.status 'exhausted' -> 'active' (the allocation makes
--        allocated_cents > spent_cents again, so 'active' is the correct state).
--      - boost_campaigns.status 'completed' -> 'pending' (revives a finished
--        campaign back into the pipeline). A live-but-exhausted campaign keeps
--        its lifecycle status and only has its budget topped up.
--    Both writes plus the wallet->campaign ledger entry are one transaction, so
--    an insufficient/failed allocation reactivates nothing.

alter table boost_campaigns alter column requires_payment set default false;

create or replace function public.allocate_campaign_budget(
  p_campaign_id uuid,
  p_amount_cents bigint,
  p_source text default 'ios',
  p_stripe_mode text default 'live'
) returns void
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

  -- Reactivation-via-allocation (2026-08-08): funding an exhausted budget is no
  -- longer blocked — it revives the campaign in this same transaction. Was:
  --   if v_status = 'exhausted' then
  --     raise exception 'campaign is exhausted — reactivate before allocating';
  --   end if;
  if v_status = 'exhausted' then
    update campaign_budgets set status = 'active', updated_at = now()
     where campaign_id = p_campaign_id;
  end if;
  -- A finished (Completed-lane) campaign comes back into the pipeline when it is
  -- funded again. A live-but-exhausted campaign is only topped up (status kept).
  update boost_campaigns set status = 'pending', status_updated_at = now()
   where id = p_campaign_id and status = 'completed';

  -- Move the amount from wallet -> campaign. No commission here anymore — the fee
  -- is charged once, at top-up (see record_wallet_topup). The apply_wallet_ledger_entry
  -- trigger decrements the wallet balance and increments campaign_budgets.allocated_cents.
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
    values (v_profile_id, -p_amount_cents, 'allocation', v_src, p_campaign_id, v_mode);
end;
$function$;
