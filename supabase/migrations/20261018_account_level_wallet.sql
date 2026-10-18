-- Move the ad-spend wallet from profile level to account level. One account
-- per auth login owns one wallet; every profile that login owns shares it.
-- Campaigns stay per profile; budget is allocated from the account wallet to
-- campaigns, regardless of which profile the campaign belongs to.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. accounts table
-- ─────────────────────────────────────────────────────────────────────────

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  anonymized_at timestamptz
);

create unique index accounts_user_id_key on public.accounts (user_id) where user_id is not null;

alter table public.profiles add column account_id uuid references public.accounts(id);

comment on table public.accounts is
  'One account per auth login. profiles.account_id points here; all of a login''s profiles share one account_wallets row. user_id goes null (FK ON DELETE SET NULL) when the auth user is deleted — the account row survives so wallet/ledger history keeps a home; accounts_set_anonymized_at stamps anonymized_at when that happens.';

-- Stamps anonymized_at the moment user_id transitions non-null -> null —
-- fires identically whether that update comes from application code or from
-- the FK's own ON DELETE SET NULL action (Postgres implements that action as
-- a regular UPDATE, which fires row triggers normally).
create or replace function public.set_account_anonymized_at()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is null and old.user_id is not null then
    new.anonymized_at := now();
  end if;
  return new;
end;
$$;

create trigger accounts_set_anonymized_at
before update on public.accounts
for each row
execute function public.set_account_anonymized_at();

-- Keeps profiles.account_id correct for every path that sets/changes
-- profiles.user_id: fresh signup (handle_new_user's INSERT), an additional
-- profile on an existing login (create_additional_profile's INSERT), and the
-- legacy claim flow (handle_new_user's UPDATE ... SET user_id = ... for a
-- seeded profile). Deliberately a no-op when NEW.user_id IS NULL: that's the
-- delete-account anonymization path (profiles.user_id scrubbed to null) —
-- the profile must KEEP pointing at its existing (now-anonymizing) account,
-- not get reassigned to some new/shared null-user_id account.
create or replace function public.profiles_assign_account_id()
returns trigger
language plpgsql
security definer
set search_path to public
as $$
declare
  v_account_id uuid;
begin
  if new.user_id is null then
    return new;
  end if;

  select id into v_account_id from accounts where user_id = new.user_id;
  if v_account_id is null then
    insert into accounts (user_id) values (new.user_id)
    on conflict (user_id) where user_id is not null
    do update set user_id = excluded.user_id
    returning id into v_account_id;
  end if;

  new.account_id := v_account_id;
  return new;
end;
$$;

create trigger profiles_set_account_id
before insert or update of user_id on public.profiles
for each row
execute function public.profiles_assign_account_id();

-- Backfill — one account per distinct non-null user_id.
insert into public.accounts (user_id)
select distinct user_id from public.profiles where user_id is not null;

update public.profiles p
set account_id = a.id
from public.accounts a
where a.user_id = p.user_id and p.user_id is not null;

-- Backfill — each null-user_id profile (anonymized/deleted) gets its OWN
-- dedicated account, not a shared one, so its ledger history keeps a home
-- without conflating two unrelated deleted accounts' balances.
do $$
declare
  r record;
  v_new_account_id uuid;
begin
  for r in select id from public.profiles where user_id is null and account_id is null loop
    insert into public.accounts (user_id) values (null) returning id into v_new_account_id;
    update public.profiles set account_id = v_new_account_id where id = r.id;
  end loop;
end;
$$;

-- stripe_customer_id backfill — the account's OLDEST profile that has one.
-- (Confirmed before writing this: no account in this project currently has
-- profiles with two DIFFERENT non-null stripe_customer_ids, so there was
-- nothing to pick between or report — see the verification report.)
update public.accounts a
set stripe_customer_id = sub.stripe_customer_id
from (
  select distinct on (p.account_id) p.account_id, p.stripe_customer_id
  from public.profiles p
  where p.stripe_customer_id is not null
  order by p.account_id, p.created_at asc
) sub
where a.id = sub.account_id;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. account wallet
-- ─────────────────────────────────────────────────────────────────────────

create table public.account_wallets (
  account_id uuid primary key references public.accounts(id),
  balance_cents bigint not null default 0,
  updated_at timestamptz default now()
);

insert into public.account_wallets (account_id, balance_cents)
select p.account_id, sum(w.balance_cents)
from public.ad_spend_wallets w
join public.profiles p on p.id = w.profile_id
group by p.account_id;

-- wallet_ledger_entries: add account_id, backfilled via profile_id -> NOT
-- NULL once every existing row has one (every row already has a profile_id,
-- and every profile now has an account_id after the backfill above).
alter table public.wallet_ledger_entries add column account_id uuid;

update public.wallet_ledger_entries l
set account_id = p.account_id
from public.profiles p
where p.id = l.profile_id;

alter table public.wallet_ledger_entries alter column account_id set not null;
alter table public.wallet_ledger_entries
  add constraint wallet_ledger_entries_account_id_fkey foreign key (account_id) references public.accounts(id);

-- apply_wallet_ledger_entry: credits/debits account_wallets by account_id
-- instead of ad_spend_wallets by profile_id. campaign_budgets logic
-- (allocation/deallocation/spend_deployment) is campaign-scoped and
-- unchanged.
create or replace function public.apply_wallet_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.entry_type in ('topup','refund','allocation','deallocation','bonus') then
    update account_wallets
       set balance_cents = balance_cents + new.amount_cents,
           updated_at = now()
     where account_id = new.account_id;
    if not found then
      insert into account_wallets (account_id, balance_cents)
      values (new.account_id, new.amount_cents);
    end if;
  end if;

  if new.entry_type in ('allocation','deallocation') then
    update campaign_budgets
       set allocated_cents = allocated_cents - new.amount_cents,
           updated_at = now()
     where campaign_id = new.campaign_id;
  elsif new.entry_type = 'spend_deployment' then
    update campaign_budgets
       set spent_cents = spent_cents - new.amount_cents,
           status = case when (spent_cents - new.amount_cents) >= allocated_cents then 'exhausted' else status end,
           updated_at = now()
     where campaign_id = new.campaign_id;
  end if;

  return new;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Functions
-- ─────────────────────────────────────────────────────────────────────────

-- record_wallet_topup: same signature (still takes p_profile_id — that's
-- which profile the top-up was made FROM, used for management_fee_charges
-- attribution), resolves the account from that profile and credits the
-- ACCOUNT wallet via the ledger.
create or replace function public.record_wallet_topup(
  p_profile_id uuid,
  p_amount_cents bigint,
  p_source text,
  p_stripe_payment_intent_id text,
  p_stripe_mode text default 'live'::text
)
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

  -- 1. Wallet credit — full amount (pure ad spend; fee is a separate charge).
  insert into wallet_ledger_entries
    (profile_id, account_id, amount_cents, entry_type, source, stripe_payment_intent_id, stripe_mode)
  values
    (p_profile_id, v_account_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id, v_mode)
  on conflict (stripe_payment_intent_id) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    return null; -- duplicate payment_intent — safe idempotent no-op, no fee row either
  end if;

  -- 2. SQRZ fee — flat 15%, kept keyed by the PROFILE the top-up was made
  --    from (not the account) — unchanged from before this migration.
  v_fee_cents := round(p_amount_cents * 0.15);
  insert into management_fee_charges (profile_id, wallet_ledger_entry_id, amount_cents, status, stripe_mode)
    values (p_profile_id, v_ledger_id, v_fee_cents, 'pending', v_mode);

  return v_ledger_id;
end;
$function$;

-- allocate_campaign_budget: debits the ACCOUNT wallet (the campaign's
-- profile's account), not the profile wallet. Ownership check unchanged in
-- spirit (the campaign's profile belongs to the caller) but now also reads
-- that profile's account_id in the same lookup.
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

  insert into wallet_ledger_entries (profile_id, account_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
    values (v_profile_id, v_account_id, -p_amount_cents, 'allocation', v_src, p_campaign_id, v_mode);
end;
$function$;

-- deallocate_campaign_budget: credits the ACCOUNT wallet.
create or replace function public.deallocate_campaign_budget(
  p_campaign_id uuid,
  p_amount_cents bigint,
  p_source text default 'ios'::text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
  v_account_id uuid;
  v_unspent bigint;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
begin
  if p_amount_cents <= 0 then raise exception 'amount must be positive'; end if;

  select bc.profile_id, p.account_id into v_profile_id, v_account_id
    from boost_campaigns bc
    join profiles p on p.id = bc.profile_id
    where bc.id = p_campaign_id;
  if v_profile_id is null or not user_owns_profile(v_profile_id) then
    raise exception 'campaign not found';
  end if;

  select (allocated_cents - spent_cents) into v_unspent from campaign_budgets where campaign_id = p_campaign_id;
  if v_unspent is null then raise exception 'no budget allocated'; end if;
  if p_amount_cents > v_unspent then raise exception 'amount exceeds unspent budget'; end if;

  insert into wallet_ledger_entries (profile_id, account_id, amount_cents, entry_type, source, campaign_id)
    values (v_profile_id, v_account_id, p_amount_cents, 'deallocation', v_src, p_campaign_id);
end;
$function$;

-- reallocate_campaign_budget: the same-PROFILE restriction added 2026-10-18
-- (multi_profile_ownership migration, before this one) was specifically to
-- stop one profile's wallet funding another profile's campaign when wallets
-- were per-profile. Now that both campaigns' money comes from the same
-- shared ACCOUNT wallet whenever they're under the same account, that
-- concern is exactly backwards — reallocating between two campaigns of the
-- SAME account is correct and safe (the two ledger entries net to zero on
-- one account_wallets row); between two DIFFERENT accounts it must still be
-- blocked. Same-profile check removed, same-account check added.
create or replace function public.reallocate_campaign_budget(
  p_from_campaign_id uuid,
  p_to_campaign_id uuid,
  p_amount_cents bigint,
  p_source text default 'ios'::text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_from_profile_id uuid;
  v_from_account_id uuid;
  v_to_profile_id uuid;
  v_to_account_id uuid;
  v_unspent bigint;
  v_to_status text;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
begin
  if p_amount_cents <= 0 then raise exception 'amount must be positive'; end if;
  if p_from_campaign_id = p_to_campaign_id then raise exception 'source and destination must differ'; end if;

  select bc.profile_id, p.account_id into v_from_profile_id, v_from_account_id
    from boost_campaigns bc
    join profiles p on p.id = bc.profile_id
    where bc.id = p_from_campaign_id;
  if v_from_profile_id is null or not user_owns_profile(v_from_profile_id) then
    raise exception 'source campaign not found';
  end if;

  select bc.profile_id, p.account_id into v_to_profile_id, v_to_account_id
    from boost_campaigns bc
    join profiles p on p.id = bc.profile_id
    where bc.id = p_to_campaign_id;
  if v_to_profile_id is null or not user_owns_profile(v_to_profile_id) then
    raise exception 'destination campaign not found';
  end if;

  if v_from_account_id <> v_to_account_id then
    raise exception 'source and destination campaigns must belong to the same account';
  end if;

  select (allocated_cents - spent_cents) into v_unspent from campaign_budgets where campaign_id = p_from_campaign_id;
  if v_unspent is null then raise exception 'no budget allocated on source'; end if;
  if p_amount_cents > v_unspent then raise exception 'amount exceeds unspent budget'; end if;

  insert into campaign_budgets (campaign_id) values (p_to_campaign_id) on conflict (campaign_id) do nothing;
  select status into v_to_status from campaign_budgets where campaign_id = p_to_campaign_id;
  if v_to_status = 'exhausted' then raise exception 'destination campaign is exhausted — reactivate before reallocating'; end if;

  -- deallocate from source (account pool +), then allocate to dest (account
  -- pool -). Same account_id on both legs -> net zero on account_wallets.
  insert into wallet_ledger_entries (profile_id, account_id, amount_cents, entry_type, source, campaign_id)
    values (v_from_profile_id, v_from_account_id, p_amount_cents, 'deallocation', v_src, p_from_campaign_id);
  insert into wallet_ledger_entries (profile_id, account_id, amount_cents, entry_type, source, campaign_id)
    values (v_to_profile_id, v_to_account_id, -p_amount_cents, 'allocation', v_src, p_to_campaign_id);
end;
$function$;

-- reset_demo_account_on_login: resets the demo profile's ACCOUNT wallet
-- (looked up via that profile's account_id) instead of its old per-profile
-- ad_spend_wallets row.
create or replace function public.reset_demo_account_on_login()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_account_id uuid;
begin
  if new.id = '883e566d-9f57-48e8-a732-301ae2b191d6'
     and new.last_sign_in_at is distinct from old.last_sign_in_at then

    select account_id into v_account_id from public.profiles where id = '1fcdd0df-0fb1-4347-b98f-2161987d7358';

    update public.account_wallets
    set balance_cents = 25000, updated_at = now()
    where account_id = v_account_id;

    update public.campaign_budgets
    set allocated_cents = 0, spent_cents = 0, status = 'active', updated_at = now()
    where campaign_id in (
      select id from public.boost_campaigns where profile_id = '1fcdd0df-0fb1-4347-b98f-2161987d7358'
    );

    delete from public.wallet_ledger_entries
    where campaign_id in (
      select id from public.boost_campaigns where profile_id = '1fcdd0df-0fb1-4347-b98f-2161987d7358'
    );
  end if;
  return new;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. RLS
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.user_owns_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from accounts where id = p_account_id and user_id = auth.uid()
  );
$$;

comment on function public.user_owns_account(uuid) is
  'True iff the current auth.uid() owns the given account. Mirrors user_owns_profile — the row-level primitive behind account/account_wallets/wallet_ledger_entries RLS.';

alter table public.accounts enable row level security;
create policy accounts_owner_read on public.accounts
  for select using (user_id = auth.uid());
-- No insert/update/delete policy — no client writes, by design. Every
-- write (account creation, stripe_customer_id, anonymized_at) happens via
-- SECURITY DEFINER functions/triggers or the service-role admin client.

alter table public.account_wallets enable row level security;
create policy account_wallets_owner_read on public.account_wallets
  for select using (user_owns_account(account_id));
-- No client writes here either — balance only ever changes via
-- apply_wallet_ledger_entry (SECURITY DEFINER trigger).

alter policy wallet_ledger_owner_read on public.wallet_ledger_entries
  using (user_owns_account(account_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Read interface: keep ad_spend_wallets readable the same way it always
--    was (profile_id, balance_cents, updated_at) — now backed by the
--    account wallet. security_invoker so the view carries no privilege of
--    its own; RLS on profiles + account_wallets (via user_owns_account)
--    does the real gating, same "another user sees nothing" guarantee as
--    before.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.ad_spend_wallets rename to ad_spend_wallets_legacy;

comment on table public.ad_spend_wallets_legacy is
  'Superseded 2026-10-18 by account_wallets (one wallet per account, not per profile) — see the ad_spend_wallets view. Kept as a frozen historical snapshot of per-profile balances at migration time; nothing reads or writes this table anymore.';

create view public.ad_spend_wallets with (security_invoker = true) as
select p.id as profile_id, aw.balance_cents, aw.updated_at
from public.profiles p
join public.account_wallets aw on aw.account_id = p.account_id;

grant select on public.ad_spend_wallets to anon, authenticated, service_role;

comment on view public.ad_spend_wallets is
  'Read-compat view (2026-10-18): every profile of an account resolves to that ONE account''s balance. profile_id, balance_cents, updated_at — same shape the old per-profile table had, so every existing reader (sqrz-ios WalletViewModel/AllocationViewModel, this repo''s reset_demo_account_on_login before it was rewritten) keeps working unchanged. The real table is account_wallets; write through apply_wallet_ledger_entry/the ledger, never this view.';
