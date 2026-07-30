-- Part 3: campaign budget allocation. Wallet funds can be assigned to specific
-- campaigns and moved between them. campaign_id is uuid (boost_campaigns.id is uuid).
-- Applied to project fmjefvdtnmgdfauedpmg via apply_migration on 2026-07-30.

-- ── campaign_budgets ────────────────────────────────────────────────────────
create table public.campaign_budgets (
  campaign_id uuid primary key references public.boost_campaigns(id) on delete cascade,
  allocated_cents bigint not null default 0,
  spent_cents bigint not null default 0,
  status text not null default 'active' check (status in ('active','paused','completed')),
  updated_at timestamptz default now()
);

alter table public.campaign_budgets enable row level security;

create policy campaign_budgets_owner_select on public.campaign_budgets
  for select using (
    campaign_id in (
      select id from public.boost_campaigns
      where profile_id = public.get_profile_id_for_user(auth.uid())
    )
  );

grant select on public.campaign_budgets to authenticated;

-- ── wallet_ledger_entries: campaign link + new entry types ──────────────────
alter table public.wallet_ledger_entries
  add column campaign_id uuid references public.boost_campaigns(id) on delete set null;

alter table public.wallet_ledger_entries
  drop constraint wallet_ledger_entries_entry_type_check;
alter table public.wallet_ledger_entries
  add constraint wallet_ledger_entries_entry_type_check
  check (entry_type in ('topup','spend_deployment','refund','allocation','deallocation'));

comment on column public.wallet_ledger_entries.campaign_id is
  'Set on allocation/deallocation/spend_deployment entries — the campaign the funds moved to/from/against. NULL for topup/refund.';

-- ── trigger: branch balance effects on entry_type ──────────────────────────
create or replace function public.apply_wallet_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- topup/refund/allocation/deallocation move the unallocated wallet pool.
  -- spend_deployment does NOT touch the wallet (that money left the pool at
  -- allocation time) — it only advances the campaign's spent_cents.
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
    -- allocation: amount negative (pool → campaign) so allocated rises by the
    -- magnitude; deallocation: amount positive (campaign → pool) so allocated
    -- falls. Both reduce to allocated_cents := allocated_cents - amount_cents.
    update campaign_budgets
       set allocated_cents = allocated_cents - new.amount_cents,
           updated_at = now()
     where campaign_id = new.campaign_id;
  elsif new.entry_type = 'spend_deployment' then
    -- amount negative; spent rises by the magnitude. Wallet untouched.
    update campaign_budgets
       set spent_cents = spent_cents - new.amount_cents,
           updated_at = now()
     where campaign_id = new.campaign_id;
  end if;

  return new;
end;
$function$;

-- ── record_campaign_start_funding (service_role; Stripe webhook) ────────────
-- Atomic Start-Campaign funding: fee-exempt topup credit + immediate allocation of
-- the same amount into the new campaign. Net wallet effect zero. Idempotent: if the
-- topup is a duplicate (same PI), the whole thing skips.
create or replace function public.record_campaign_start_funding(
  p_profile_id uuid,
  p_campaign_id uuid,
  p_amount_cents bigint,
  p_source text,
  p_stripe_payment_intent_id text
)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ledger_id bigint;
begin
  v_ledger_id := record_wallet_topup(p_profile_id, p_amount_cents, p_source, p_stripe_payment_intent_id, true);
  if v_ledger_id is null then
    return null; -- duplicate webhook — original tx already funded + allocated
  end if;

  insert into campaign_budgets (campaign_id) values (p_campaign_id) on conflict (campaign_id) do nothing;
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (p_profile_id, -p_amount_cents, 'allocation', p_source, p_campaign_id);

  return v_ledger_id;
end;
$function$;

revoke execute on function public.record_campaign_start_funding(uuid,uuid,bigint,text,text) from public, anon, authenticated;
grant execute on function public.record_campaign_start_funding(uuid,uuid,bigint,text,text) to service_role;

-- ── allocate_campaign_budget (auth-scoped; iOS) ─────────────────────────────
create or replace function public.allocate_campaign_budget(
  p_campaign_id uuid,
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
  v_balance bigint;
  v_status text;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
begin
  if p_amount_cents <= 0 then raise exception 'amount must be positive'; end if;
  select id into v_profile_id from profiles where user_id = auth.uid();
  if v_profile_id is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from boost_campaigns where id = p_campaign_id and profile_id = v_profile_id) then
    raise exception 'campaign not found';
  end if;
  select balance_cents into v_balance from ad_spend_wallets where profile_id = v_profile_id;
  if coalesce(v_balance, 0) < p_amount_cents then raise exception 'insufficient wallet balance'; end if;

  insert into campaign_budgets (campaign_id) values (p_campaign_id) on conflict (campaign_id) do nothing;
  select status into v_status from campaign_budgets where campaign_id = p_campaign_id;
  if v_status = 'completed' then raise exception 'campaign is completed'; end if;

  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (v_profile_id, -p_amount_cents, 'allocation', v_src, p_campaign_id);
end;
$function$;

grant execute on function public.allocate_campaign_budget(uuid,bigint,text) to authenticated;

-- ── deallocate_campaign_budget (auth-scoped) ────────────────────────────────
create or replace function public.deallocate_campaign_budget(
  p_campaign_id uuid,
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
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
begin
  if p_amount_cents <= 0 then raise exception 'amount must be positive'; end if;
  select id into v_profile_id from profiles where user_id = auth.uid();
  if v_profile_id is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from boost_campaigns where id = p_campaign_id and profile_id = v_profile_id) then
    raise exception 'campaign not found';
  end if;
  select (allocated_cents - spent_cents) into v_unspent from campaign_budgets where campaign_id = p_campaign_id;
  if v_unspent is null then raise exception 'no budget allocated'; end if;
  if p_amount_cents > v_unspent then raise exception 'amount exceeds unspent budget'; end if;

  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (v_profile_id, p_amount_cents, 'deallocation', v_src, p_campaign_id);
end;
$function$;

grant execute on function public.deallocate_campaign_budget(uuid,bigint,text) to authenticated;

-- ── reallocate_campaign_budget (auth-scoped) — move unspent between campaigns ─
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
  if v_to_status = 'completed' then raise exception 'destination campaign is completed'; end if;

  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (v_profile_id, p_amount_cents, 'deallocation', v_src, p_from_campaign_id);
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (v_profile_id, -p_amount_cents, 'allocation', v_src, p_to_campaign_id);
end;
$function$;

grant execute on function public.reallocate_campaign_budget(uuid,uuid,bigint,text) to authenticated;

-- ── set_campaign_budget_status (auth-scoped) — pause / restart / complete ───
create or replace function public.set_campaign_budget_status(
  p_campaign_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
begin
  if p_status not in ('active','paused','completed') then raise exception 'invalid status'; end if;
  select id into v_profile_id from profiles where user_id = auth.uid();
  if v_profile_id is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from boost_campaigns where id = p_campaign_id and profile_id = v_profile_id) then
    raise exception 'campaign not found';
  end if;

  insert into campaign_budgets (campaign_id, status) values (p_campaign_id, p_status)
  on conflict (campaign_id) do update set status = excluded.status, updated_at = now();
end;
$function$;

grant execute on function public.set_campaign_budget_status(uuid,text) to authenticated;
