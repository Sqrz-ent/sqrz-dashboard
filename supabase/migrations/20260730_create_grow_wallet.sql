-- SQRZ Grow — ad-spend wallet, management-fee ledger, and grow-client gating.
-- Decoupled from the iOS Companion subscription (ios_subscriptions): advisor
-- access depends on grow_clients.status, NEVER on ios_subscriptions.
--
-- Core financial principle preserved here: the wallet holds PURE ad spend. The
-- 20% management fee is a SEPARATE financial event (management_fee_charges),
-- never netted out of the wallet balance.

-- ── grow_clients ──────────────────────────────────────────────────────────────
-- Source of truth for Grow-client status / advisor gating going forward.
-- Intentionally NOT the legacy profiles.grow_qualified boolean (see the
-- migration note / CLAUDE.md — grow_qualified is a dormant, trigger-written
-- column that nothing reads for gating; it should be deprecated/aligned to this
-- table in a follow-up, not left as a second conflicting source of truth).
create table grow_clients (
  profile_id uuid references profiles(id) on delete cascade primary key,
  status text not null check (status in ('active', 'paused', 'offboarded')),
  fee_percentage numeric not null default 20.0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table grow_clients enable row level security;

-- Owner-read only. profiles.id ≠ auth.users.id (Critical ID Rules) — resolved
-- via the existing SECURITY DEFINER helper, never `= auth.uid()`.
create policy "grow_clients_owner_read"
  on grow_clients for select
  using (profile_id = get_profile_id_for_user(auth.uid()));
-- No client-side writes — status changes via admin/internal tooling only.

create trigger grow_clients_updated_at
  before update on grow_clients
  for each row execute function handle_updated_at();

-- ── ad_spend_wallets ──────────────────────────────────────────────────────────
-- Pure ad-spend balance. Only ever mutated by the ledger trigger below — never
-- written directly by clients (and the app should never write it directly
-- either; insert a ledger entry instead, so balance and ledger stay in sync).
create table ad_spend_wallets (
  profile_id uuid references profiles(id) on delete cascade primary key,
  balance_cents bigint not null default 0,
  updated_at timestamptz default now()
);

alter table ad_spend_wallets enable row level security;

create policy "ad_spend_wallets_owner_read"
  on ad_spend_wallets for select
  using (profile_id = get_profile_id_for_user(auth.uid()));

-- ── wallet_ledger_entries ─────────────────────────────────────────────────────
-- The append-only source of truth for wallet movement. Positive amount =
-- topup/refund; negative = spend_deployment. Channel deployment (Meta/TikTok/…)
-- is SQRZ business discretion, logged for transparency, never client-selected.
create table wallet_ledger_entries (
  id bigint generated always as identity primary key,
  profile_id uuid references profiles(id) on delete cascade not null,
  amount_cents bigint not null,
  entry_type text not null check (entry_type in ('topup', 'spend_deployment', 'refund')),
  channel text,                                            -- spend_deployment only
  source text not null check (source in ('web', 'ios')),   -- analytics only, never gating
  stripe_payment_intent_id text,                           -- topup entries only
  notes text,                                              -- internal note on spend_deployment
  created_at timestamptz default now()
);

create index idx_wallet_ledger_profile_id on wallet_ledger_entries(profile_id);
create index idx_wallet_ledger_entry_type on wallet_ledger_entries(entry_type);

alter table wallet_ledger_entries enable row level security;

create policy "wallet_ledger_owner_read"
  on wallet_ledger_entries for select
  using (profile_id = get_profile_id_for_user(auth.uid()));
-- No client-side writes — entries are inserted by the record_wallet_topup RPC
-- (from the Stripe webhook, service role) or internal spend-deployment tooling.

-- Keep the wallet balance in lockstep with the ledger — never trust a client to
-- sum entries. Upserts the wallet row on first entry.
create or replace function apply_wallet_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update ad_spend_wallets
     set balance_cents = balance_cents + new.amount_cents,
         updated_at = now()
   where profile_id = new.profile_id;

  if not found then
    insert into ad_spend_wallets (profile_id, balance_cents)
    values (new.profile_id, new.amount_cents);
  end if;

  return new;
end;
$$;

create trigger on_wallet_ledger_entry_insert
  after insert on wallet_ledger_entries
  for each row execute function apply_wallet_ledger_entry();

-- ── management_fee_charges ────────────────────────────────────────────────────
-- The 20% management fee — a SEPARATE financial event from the wallet balance.
-- status starts 'pending'; flipped to 'wired' by internal/admin tooling once the
-- real-world wire settles (not automated in this pass).
create table management_fee_charges (
  id bigint generated always as identity primary key,
  profile_id uuid references profiles(id) on delete cascade not null,
  wallet_ledger_entry_id bigint references wallet_ledger_entries(id) not null,
  amount_cents bigint not null,
  status text not null check (status in ('pending', 'wired', 'failed')) default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_management_fee_charges_profile_id on management_fee_charges(profile_id);

alter table management_fee_charges enable row level security;

create policy "management_fee_charges_owner_read"
  on management_fee_charges for select
  using (profile_id = get_profile_id_for_user(auth.uid()));

create trigger management_fee_charges_updated_at
  before update on management_fee_charges
  for each row execute function handle_updated_at();

-- ── get_grow_client_status() → boolean ────────────────────────────────────────
-- The single client-facing entitlement check (render locked/unlocked UI).
-- auth.uid()-scoped with NO externally-supplied profile_id — a SECURITY DEFINER
-- function taking an arbitrary profile_id would let any caller read anyone's
-- status. Matches the get_companion_subscription_status() precedent.
-- NOTE: the campaign-advisor server gate does NOT call this — it runs with the
-- service role (no auth.uid()) and checks grow_clients by the campaign's
-- profile_id directly. Same table, single source of truth.
create or replace function get_grow_client_status()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from grow_clients gc
    where gc.profile_id = get_profile_id_for_user(auth.uid())
      and gc.status = 'active'
  );
$$;

-- ── record_wallet_topup(...) — atomic ledger + fee insert ─────────────────────
-- Called ONLY by the Stripe webhook (service role) after a successful wallet
-- top-up payment. Does the ledger credit AND the management-fee charge in ONE
-- function body (a single transaction) — a top-up that credits the wallet but
-- fails to record the fee would be a revenue leak, so the two must be atomic.
--
-- SECURITY: locked to service_role only (revoked from anon/authenticated below).
-- A SECURITY DEFINER function that credits wallets must never be client-callable
-- — that would let anyone top up their own wallet without paying.
create or replace function record_wallet_topup(
  p_profile_id uuid,
  p_amount_cents bigint,
  p_source text,
  p_stripe_payment_intent_id text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id bigint;
  v_fee_pct numeric;
  v_fee_cents bigint;
begin
  -- 1. Wallet credit — full amount (pure ad spend; fee is separate).
  insert into wallet_ledger_entries
    (profile_id, amount_cents, entry_type, source, stripe_payment_intent_id)
  values
    (p_profile_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id)
  returning id into v_ledger_id;
  -- (the on_wallet_ledger_entry_insert trigger updates ad_spend_wallets.)

  -- 2. Management fee — separate charge, pulled from the client's fee_percentage
  --    (defaults to 20% if there's no grow_clients row yet).
  select coalesce(gc.fee_percentage, 20.0)
    into v_fee_pct
    from (select 1) dummy
    left join grow_clients gc on gc.profile_id = p_profile_id;

  v_fee_cents := round(p_amount_cents * v_fee_pct / 100.0);

  insert into management_fee_charges
    (profile_id, wallet_ledger_entry_id, amount_cents, status)
  values
    (p_profile_id, v_ledger_id, v_fee_cents, 'pending');

  return v_ledger_id;
end;
$$;

revoke execute on function record_wallet_topup(uuid, bigint, text, text)
  from public, anon, authenticated;
grant execute on function record_wallet_topup(uuid, bigint, text, text)
  to service_role;
