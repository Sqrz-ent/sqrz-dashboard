-- Allocation-fee model (2026-08-01). Commission moves off top-up and onto
-- allocation; per-profile tiers; campaign_budgets simplified to active/exhausted
-- with an auto-exhaust trigger; top-ups become unconditionally fee-free.
-- Applied via apply_migration on 2026-08-01.

-- ── client_fee_tiers ────────────────────────────────────────────────────────
-- No row = standard tier, 15%. A row = explicit admin override (e.g. 'wire' 25%).
-- Assigned manually/by admin for now; no self-serve UI. Owner may read their own
-- (transparency); writes are service-role/admin only (no authenticated policy).
create table if not exists public.client_fee_tiers (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  tier text not null default 'standard',
  fee_percentage numeric not null default 15.0,
  assigned_at timestamptz default now(),
  notes text
);
alter table public.client_fee_tiers enable row level security;
drop policy if exists client_fee_tiers_owner_select on public.client_fee_tiers;
create policy client_fee_tiers_owner_select on public.client_fee_tiers for select
  using (profile_id = public.get_profile_id_for_user(auth.uid()));
grant select on public.client_fee_tiers to authenticated;

-- ── Drop record_campaign_start_funding (campaign creation no longer bundles a
-- budget — it charges the flat $25 setup fee only, so nothing funds/allocates at
-- creation time). Drop before record_wallet_topup since it called it. ──────────
drop function if exists public.record_campaign_start_funding(uuid,uuid,bigint,text,text,text);
drop function if exists public.record_campaign_start_funding(uuid,uuid,bigint,text,text);

-- ── record_wallet_topup → fee-free (the fee now attaches to allocation). Keeps
-- payment_intent idempotency (ON CONFLICT DO NOTHING → NULL on duplicate) which a
-- prior stripe_mode migration this session had accidentally dropped. Drops the
-- p_fee_exempt param (every top-up is fee-free now, unconditionally). ──────────
drop function if exists public.record_wallet_topup(uuid,bigint,text,text,boolean,text);
drop function if exists public.record_wallet_topup(uuid,bigint,text,text,boolean);

create function public.record_wallet_topup(
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
begin
  -- No management-fee row here anymore — top-ups are unconditionally fee-free;
  -- the commission is charged at allocation time (see allocate_campaign_budget).
  insert into wallet_ledger_entries
    (profile_id, amount_cents, entry_type, source, stripe_payment_intent_id, stripe_mode)
  values
    (p_profile_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id, v_mode)
  on conflict (stripe_payment_intent_id) do nothing
  returning id into v_ledger_id;
  return v_ledger_id; -- NULL on duplicate payment_intent (safe idempotent no-op)
end;
$function$;
revoke execute on function public.record_wallet_topup(uuid,bigint,text,text,text) from public, anon, authenticated;
grant execute on function public.record_wallet_topup(uuid,bigint,text,text,text) to service_role;

-- ── set_campaign_budget_status — drop. Its only caller (iOS pause/restart) was
-- already removed, and 'paused' is going away. ────────────────────────────────
drop function if exists public.set_campaign_budget_status(uuid,text);

-- ── allocate_campaign_budget → pill-only + tiered commission linked to THIS
-- allocation. Drop the 3-arg first (adding p_stripe_mode changes the signature). ─
drop function if exists public.allocate_campaign_budget(uuid,bigint,text);

create function public.allocate_campaign_budget(
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
  v_balance bigint;
  v_status text;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
  v_mode text := case when p_stripe_mode in ('live','test') then p_stripe_mode else 'live' end;
  v_rate numeric;
  v_ledger_id bigint;
  v_fee_cents bigint;
begin
  -- Pill amounts only ($25/$50/$100/$150). Enforced here too, not just client-side.
  if p_amount_cents not in (2500, 5000, 10000, 15000) then
    raise exception 'allocation must be one of $25/$50/$100/$150';
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

  -- Move the pill from wallet → campaign. The apply_wallet_ledger_entry trigger
  -- decrements the wallet balance and increments campaign_budgets.allocated_cents.
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
    values (v_profile_id, -p_amount_cents, 'allocation', v_src, p_campaign_id, v_mode)
    returning id into v_ledger_id;

  -- Commission is a SEPARATE financial event, never netted from the wallet — the
  -- full pill funds the campaign. Linked to THIS allocation entry (not a top-up).
  v_fee_cents := round(p_amount_cents * v_rate / 100.0);
  insert into management_fee_charges (profile_id, wallet_ledger_entry_id, amount_cents, status, stripe_mode)
    values (v_profile_id, v_ledger_id, v_fee_cents, 'pending', v_mode);
end;
$function$;
revoke execute on function public.allocate_campaign_budget(uuid,bigint,text,text) from public, anon;
grant execute on function public.allocate_campaign_budget(uuid,bigint,text,text) to authenticated;

-- ── reallocate_campaign_budget — no commission (money already paid its one-time
-- fee at first allocation); only change is the status guard 'completed'→'exhausted'. ─
create or replace function public.reallocate_campaign_budget(
  p_from_campaign_id uuid,
  p_to_campaign_id uuid,
  p_amount_cents bigint,
  p_source text default 'ios'
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
  v_unspent bigint;
  v_to_status text;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
begin
  if p_amount_cents <= 0 then raise exception 'amount must be positive'; end if;
  if p_from_campaign_id = p_to_campaign_id then raise exception 'source and destination must differ'; end if;
  select id into v_profile_id from profiles where user_id = auth.uid();
  if v_profile_id is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from boost_campaigns where id = p_from_campaign_id and profile_id = v_profile_id) then
    raise exception 'source campaign not found';
  end if;
  if not exists (select 1 from boost_campaigns where id = p_to_campaign_id and profile_id = v_profile_id) then
    raise exception 'destination campaign not found';
  end if;
  select (allocated_cents - spent_cents) into v_unspent from campaign_budgets where campaign_id = p_from_campaign_id;
  if v_unspent is null then raise exception 'no budget allocated on source'; end if;
  if p_amount_cents > v_unspent then raise exception 'amount exceeds unspent budget'; end if;

  insert into campaign_budgets (campaign_id) values (p_to_campaign_id) on conflict (campaign_id) do nothing;
  select status into v_to_status from campaign_budgets where campaign_id = p_to_campaign_id;
  if v_to_status = 'exhausted' then raise exception 'destination campaign is exhausted — reactivate before reallocating'; end if;

  -- deallocate from source (pool +), then allocate to dest (pool -). Net pool zero.
  -- No management-fee row — reallocation carries no new commission.
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (v_profile_id, p_amount_cents, 'deallocation', v_src, p_from_campaign_id);
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (v_profile_id, -p_amount_cents, 'allocation', v_src, p_to_campaign_id);
end;
$function$;

-- ── apply_wallet_ledger_entry — add the auto-exhaust transition on spend. When a
-- spend_deployment pushes spent_cents to/over allocated_cents, flip to 'exhausted'
-- in the same UPDATE (SET references pre-update column values). ────────────────
create or replace function public.apply_wallet_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.entry_type in ('topup','refund','allocation','deallocation') then
    update ad_spend_wallets
       set balance_cents = balance_cents + new.amount_cents,
           updated_at = now()
     where profile_id = new.profile_id;
    if not found then
      insert into ad_spend_wallets (profile_id, balance_cents)
      values (new.profile_id, new.amount_cents);
    end if;
  end if;

  if new.entry_type in ('allocation','deallocation') then
    update campaign_budgets
       set allocated_cents = allocated_cents - new.amount_cents,
           updated_at = now()
     where campaign_id = new.campaign_id;
  elsif new.entry_type = 'spend_deployment' then
    -- amount negative; spent rises by the magnitude. Wallet untouched. Auto-flip
    -- to exhausted once spend catches up to the allocation (references OLD values).
    update campaign_budgets
       set spent_cents = spent_cents - new.amount_cents,
           status = case when (spent_cents - new.amount_cents) >= allocated_cents then 'exhausted' else status end,
           updated_at = now()
     where campaign_id = new.campaign_id;
  end if;

  return new;
end;
$function$;

-- ── campaign_budgets.status → active | exhausted (drop paused/completed) ───────
update public.campaign_budgets set status = 'active' where status not in ('active','exhausted');
alter table public.campaign_budgets drop constraint if exists campaign_budgets_status_check;
alter table public.campaign_budgets add constraint campaign_budgets_status_check
  check (status in ('active','exhausted'));

-- ── Drop wallet_ledger_entries.fee_exempt (no readers remain) ─────────────────
alter table public.wallet_ledger_entries drop column if exists fee_exempt;

-- ── Repoint the meaning of management_fee_charges.wallet_ledger_entry_id ───────
comment on column public.management_fee_charges.wallet_ledger_entry_id is
  'The wallet_ledger_entries row this commission attaches to. As of the allocation-fee model (2026-08-01) that is the ALLOCATION entry (entry_type=''allocation'') that triggered it — top-ups are now fee-free, so this no longer points at a top-up.';
