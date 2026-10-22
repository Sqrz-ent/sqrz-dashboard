-- Budget-after-booking fix (2026-10-22): campaign creation/activation never
-- looks at money, for free AND paying (grow_access) users alike — budget
-- always comes after the campaign is booked. Two changes:
--
-- 1. record_campaign_activation's default p_target_status flips from
--    'in_review' to 'awaiting_budget'. verify-campaign-activation (the real
--    caller) used to pass an explicit grow_access-derived value here
--    ('in_review' for premium, 'awaiting_budget' for free) — that branch is
--    removed in the same pass (see the edge function's own updated header),
--    so it now relies on this default, landing EVERY successful activation
--    on awaiting_budget regardless of tier. apple-consumable-webhook (the
--    backup/ONE_TIME_CHARGE activation path) never passed this parameter
--    either, so it picks up the corrected default automatically with no
--    code change of its own — it had the identical latent bug (always
--    'in_review', no tier check at all) before this migration.
--
-- 2. allocate_campaign_budget now ALSO flips awaiting_budget -> in_review on
--    a successful allocation, in addition to its existing completed ->
--    pending reactivation-via-allocation behavior. This is the SAME
--    transition complete_campaign_budget_payment already performs for the
--    free (Stripe/wire) path — it's what lets
--    on_boost_campaign_submit_meta_create fire (meta-campaign-create), so
--    the Meta campaign is only ever created once real budget money has
--    actually moved, for both paths, never before.

create or replace function public.record_campaign_activation(
  p_campaign_id uuid,
  p_profile_id uuid,
  p_product_id text,
  p_transaction_id text,
  p_original_transaction_id text,
  p_environment text,
  p_price numeric,
  p_currency text,
  p_purchased_at timestamptz,
  p_target_status text default 'awaiting_budget'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_activation_id uuid;
  v_updated_rows int;
begin
  if p_target_status not in ('in_review', 'awaiting_budget') then
    raise exception 'invalid target status: %', p_target_status;
  end if;

  insert into campaign_activations (
    campaign_id, profile_id, product_id, transaction_id, original_transaction_id,
    environment, price, currency, status, purchased_at
  ) values (
    p_campaign_id, p_profile_id, p_product_id, p_transaction_id, p_original_transaction_id,
    p_environment, p_price, p_currency, 'active', p_purchased_at
  )
  returning id into v_activation_id;

  -- 'in_review' fires on_boost_campaign_submit_meta_create. 'awaiting_budget'
  -- (now the default, 2026-10-22) does not match that trigger's WHEN clause
  -- (new.status = 'in_review') — Meta creation correctly waits until
  -- allocate_campaign_budget (premium) or complete_campaign_budget_payment
  -- (free) later advances it to in_review.
  update boost_campaigns
  set status = p_target_status, status_updated_at = now()
  where id = p_campaign_id
    and status in ('booked', 'needs_changes');
  get diagnostics v_updated_rows = row_count;

  return jsonb_build_object(
    'activation_id', v_activation_id,
    'campaign_advanced', v_updated_rows > 0,
    'status', p_target_status
  );
end;
$function$;

create or replace function public.allocate_campaign_budget(
  p_campaign_id uuid,
  p_amount_cents bigint,
  p_source text default 'ios',
  p_stripe_mode text default 'live'
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
  v_account_id uuid;
  v_balance bigint;
  v_status text;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
  v_mode text := case when p_stripe_mode in ('live','test') then p_stripe_mode else 'live' end;
begin
  if p_amount_cents < 1000 then
    raise exception 'minimum allocation is $10';
  end if;

  select bc.profile_id, p.account_id into v_profile_id, v_account_id
    from boost_campaigns bc
    join profiles p on p.id = bc.profile_id
    where bc.id = p_campaign_id;
  if v_profile_id is null or not user_owns_profile(v_profile_id) then
    raise exception 'campaign not found';
  end if;

  select balance_cents into v_balance from account_wallets where account_id = v_account_id;
  if coalesce(v_balance, 0) < p_amount_cents then raise exception 'insufficient wallet balance'; end if;

  insert into campaign_budgets (campaign_id) values (p_campaign_id) on conflict (campaign_id) do nothing;
  select status into v_status from campaign_budgets where campaign_id = p_campaign_id;

  if v_status = 'exhausted' then
    update campaign_budgets set status = 'active', updated_at = now()
     where campaign_id = p_campaign_id;
  end if;
  update boost_campaigns set status = 'pending', status_updated_at = now()
   where id = p_campaign_id and status = 'completed';

  -- Budget-after-booking fix (2026-10-22): the FIRST allocation on a booked
  -- campaign is what actually launches it now (both free and premium land
  -- on awaiting_budget after activation; the free path's own equivalent
  -- transition already lives in complete_campaign_budget_payment).
  update boost_campaigns set status = 'in_review', status_updated_at = now()
   where id = p_campaign_id and status = 'awaiting_budget';

  insert into wallet_ledger_entries (profile_id, account_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
    values (v_profile_id, v_account_id, -p_amount_cents, 'allocation', v_src, p_campaign_id, v_mode);
end;
$function$;
