-- Free-user campaign-activation path (2026-10-21 follow-up to
-- campaign_activations): a campaign activated without grow_access waits for
-- its ad budget to be paid separately (card via Stripe, or wire) before
-- meta-campaign-create fires. Premium (grow_access) is untouched — activation
-- still goes straight to in_review and the artist allocates from existing
-- wallet balance via the unchanged allocate_campaign_budget RPC.
--
-- This file reflects the FINAL, correct state of this change. The first
-- version of complete_campaign_budget_payment called record_wallet_topup
-- internally, which double-called it against api.stripe.webhook.tsx's own
-- existing (unchanged) call one step earlier — always hit
-- record_wallet_topup's stripe_payment_intent_id uniqueness guard and
-- silently skipped the allocation every time. Caught via a rolled-back-
-- transaction test before any real deployment used it; fixed here directly
-- rather than preserved as a separate "fix" migration, since nothing ever
-- depended on the buggy intermediate version.

-- 1. Widen the status CHECK to allow the new intermediate status.
alter table boost_campaigns drop constraint boost_campaigns_status_check;
alter table boost_campaigns add constraint boost_campaigns_status_check
  check (
    (campaign_type = 'boost' and status = any (array[
      'pending','booked','in_review','needs_changes','approved','live',
      'completed','rejected','awaiting_budget'
    ]))
    or campaign_type <> 'boost'
  );

-- 2. record_campaign_activation: which status activation lands on is now a
-- parameter (trailing, defaulted). verify-campaign-activation passes
-- 'in_review' for grow_access callers (unchanged behavior) and
-- 'awaiting_budget' for everyone else.
--
-- NOTE on CREATE OR REPLACE + appended parameters: adding a new trailing
-- parameter does NOT replace the existing catalog entry in Postgres — it
-- creates a SEPARATE overload with its own default (PUBLIC-executable!) ACL.
-- Confirmed live the hard way (see the grants section below) — this file
-- drops the old 9-arg overload outright rather than leaving two around.
create or replace function record_campaign_activation(
  p_campaign_id uuid,
  p_profile_id uuid,
  p_product_id text,
  p_transaction_id text,
  p_original_transaction_id text,
  p_environment text,
  p_price numeric,
  p_currency text,
  p_purchased_at timestamptz,
  p_target_status text default 'in_review'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  -- 'in_review' fires on_boost_campaign_submit_meta_create (unchanged,
  -- grow_access path). 'awaiting_budget' does not match that trigger's WHEN
  -- clause (new.status = 'in_review') — Meta creation correctly waits until
  -- complete_campaign_budget_payment later advances it to in_review.
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
$$;

-- Drop the now-dead 9-arg overload from the previous migration — verify-
-- campaign-activation always passes all 10 args (including p_target_status)
-- going forward, so keeping it around is pure attack surface for no benefit.
drop function if exists record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz);

-- The 10-arg overload above is a fresh pg_proc entry (see the NOTE above) —
-- it does NOT inherit the previous migration's service_role-only lockdown.
-- Re-apply it explicitly; confirmed empirically via has_function_privilege
-- that without this, anon/authenticated could call it directly, bypassing
-- every check verify-campaign-activation performs (ownership, JWS
-- verification, product match) — including choosing
-- p_target_status='in_review' to fire meta-campaign-create for free.
revoke all on function record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz, text) from public;
revoke all on function record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz, text) from anon;
revoke all on function record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz, text) from authenticated;
grant execute on function record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz, text) to service_role;

-- 3. complete_campaign_budget_payment — service_role only (called from
-- api.stripe.webhook.tsx AFTER its existing, unchanged wallet_topup branch —
-- record_wallet_topup — has already credited the wallet in full for a
-- campaign-linked checkout session). Allocates that SAME amount to the
-- campaign (same ledger shape as allocate_campaign_budget, minus the
-- auth.uid()-based ownership check — this function is trusted via the
-- Stripe-verified webhook caller, not a direct client call) and advances the
-- campaign out of awaiting_budget, firing on_boost_campaign_submit_meta_create.
--
-- Idempotency: locks and checks the campaign's own status (FOR UPDATE) rather
-- than trying to dedupe on stripe_payment_intent_id (allocation ledger rows
-- don't carry one) — only a campaign still at 'awaiting_budget' gets
-- allocated + advanced; anything else (already advanced by an earlier
-- successful call) is a no-op. Also closes the race between two
-- near-simultaneous webhook deliveries for the same campaign.
create or replace function complete_campaign_budget_payment(
  p_campaign_id uuid,
  p_amount_cents bigint,
  p_stripe_payment_intent_id text,
  p_source text default 'ios',
  p_stripe_mode text default 'live'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_account_id uuid;
  v_status text;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
  v_mode text := case when p_stripe_mode in ('live','test') then p_stripe_mode else 'live' end;
begin
  select bc.profile_id, p.account_id, bc.status
    into v_profile_id, v_account_id, v_status
  from boost_campaigns bc
  join profiles p on p.id = bc.profile_id
  where bc.id = p_campaign_id
  for update;

  if v_profile_id is null then
    raise exception 'campaign not found';
  end if;

  if v_status is distinct from 'awaiting_budget' then
    return jsonb_build_object('duplicate', true);
  end if;

  insert into campaign_budgets (campaign_id) values (p_campaign_id)
    on conflict (campaign_id) do nothing;

  insert into wallet_ledger_entries
    (profile_id, account_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
  values
    (v_profile_id, v_account_id, -p_amount_cents, 'allocation', v_src, p_campaign_id, v_mode);

  update boost_campaigns
  set status = 'in_review', status_updated_at = now()
  where id = p_campaign_id;

  return jsonb_build_object('campaign_advanced', true);
end;
$$;

revoke all on function complete_campaign_budget_payment(uuid, bigint, text, text, text) from public;
revoke all on function complete_campaign_budget_payment(uuid, bigint, text, text, text) from anon;
revoke all on function complete_campaign_budget_payment(uuid, bigint, text, text, text) from authenticated;
grant execute on function complete_campaign_budget_payment(uuid, bigint, text, text, text) to service_role;

-- 4. Wire-transfer instructions, world-readable, referenced by the client's
-- new Budget Payment screen — placeholder content, real bank details are a
-- manual follow-up (same "flag, don't fabricate" convention as every other
-- real-world-detail gap in this project).
insert into app_config (key, value)
values ('campaign_budget_wire_instructions', '{
  "bank_name": "TBD — Will to fill in",
  "account_holder": "SQRZ Enterprises Inc.",
  "account_number": "TBD — Will to fill in",
  "routing_number": "TBD — Will to fill in",
  "swift_bic": "TBD — Will to fill in",
  "note": "Include your campaign reference in the wire memo so we can match your payment."
}'::jsonb)
on conflict (key) do nothing;
