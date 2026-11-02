-- 2026-11-10 — Wallet top-up by bank transfer (USD + EUR). NOT APPLIED (written for review).
-- Docs: docs/wallet/wire-topup.md.
--
-- Flow: user requests a transfer (edge fn wire-topup-create) → gets bank details + exact amount + a
-- reference code → sends the money → Will marks it received in the iOS Sandbox sheet (edge fn
-- wire-topup-admin → credit_wire_topup below) → the wallet is credited through record_wallet_topup,
-- the SAME function the Stripe webhook uses (ledger entry + management_fee_charges row + balance trigger).
--
-- Seeds NO bank details. wire_accounts is empty and the feature flag is off until Will fills both in.

begin;

-- ─── 1. wire_accounts — Will's bank details, one row per currency ────────────
-- Edited by Will only (Supabase Table Editor / service role). Signed-in users may READ ACTIVE rows
-- (that is how the app shows "send the money here"). Every column is therefore user-visible —
-- including `notes`; put internal remarks somewhere else.
create table public.wire_accounts (
  currency       text primary key check (currency in ('USD', 'EUR')),
  account_holder text not null,
  bank_name      text not null,
  account_number text not null,          -- account number (USD) or IBAN (EUR)
  routing_number text,                   -- ABA routing number (USD)
  swift_bic      text,
  bank_address   text,
  notes          text,                   -- shown to the user under the bank details
  is_active      boolean not null default false,
  updated_at     timestamptz not null default now()
);

alter table public.wire_accounts enable row level security;
create policy wire_accounts_read_active on public.wire_accounts
  for select to authenticated using (is_active);
revoke all on public.wire_accounts from anon, authenticated;
grant select on public.wire_accounts to authenticated;
grant all on public.wire_accounts to service_role;

create trigger wire_accounts_updated_at before update on public.wire_accounts
  for each row execute function public.handle_updated_at();

comment on table public.wire_accounts is
  '[SQRZ] Bank details shown to users for wallet top-ups by bank transfer, one row per currency (USD/EUR). Edited by Will only; signed-in users can read active rows; no client writes. See docs/wallet/wire-topup.md.';

-- ─── 2. app_config keys (same shape as the existing flags: key text, value jsonb) ─────────────
-- The four requested keys + three extra limits (max amount, max pending, FX). `on conflict do
-- nothing` so re-running never overwrites a value Will has edited. CARD top-up fee config is untouched.
insert into public.app_config (key, value) values
  ('wire_topup_enabled',     'false'::jsonb),              -- master switch; false = option hidden, create refuses
  ('wire_topup_min_cents',   '5000'::jsonb),               -- min wallet credit, USD cents ($50)
  ('wire_topup_max_cents',   '500000'::jsonb),             -- max wallet credit, USD cents ($5,000)
  ('wire_fee_pct',           '2'::jsonb),                  -- % added on top of the credit — PLACEHOLDER, set the real rate (card is 7%)
  ('wire_expiry_days',       '7'::jsonb),                  -- days a pending transfer stays open
  ('wire_topup_max_pending', '3'::jsonb),                  -- open (pending, unexpired) transfers per account
  ('wire_fx_rates',          '{"USD": 1, "EUR": 0}'::jsonb) -- USD per 1 unit of currency; EUR 0 = not configured → EUR refused
on conflict (key) do nothing;

-- ─── 3. wire_topups — one row per requested transfer ─────────────────────────
-- amount_cents / fee_cents are in the WALLET currency (USD): amount = what the wallet is credited,
-- fee = SQRZ's fee on top. transfer_amount_cents is what the user actually sends, in `currency`
-- (= ceil((amount + fee) / fx_rate); equal to amount + fee for USD). fx_rate and fee_pct are
-- snapshotted at request time so later config edits don't change an open quote.
create table public.wire_topups (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references public.accounts(id),
  profile_id            uuid not null,   -- profile the request was made from (ledger rows need one); no FK so account deletion isn't blocked
  requested_by          uuid references auth.users(id) on delete set null,
  source                text not null default 'web' check (source in ('web', 'ios')),
  currency              text not null check (currency in ('USD', 'EUR')),
  amount_cents          bigint not null check (amount_cents > 0),
  fee_cents             bigint not null check (fee_cents >= 0),
  fee_pct               numeric not null,
  fx_rate               numeric not null default 1 check (fx_rate > 0),
  transfer_amount_cents bigint not null check (transfer_amount_cents > 0),
  reference_code        text not null unique
                          check (reference_code ~ '^SQRZ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$'),
  status                text not null default 'pending'
                          check (status in ('pending', 'received', 'expired', 'cancelled')),
  expires_at            timestamptz not null,
  received_amount_cents bigint,          -- what actually arrived, in `currency`
  received_at           timestamptz,
  received_by           uuid references auth.users(id) on delete set null,
  credited_cents        bigint,          -- what the wallet was credited (USD)
  credited_fee_cents    bigint,          -- fee recorded (USD)
  ledger_entry_id       bigint references public.wallet_ledger_entries(id) on delete set null,
  created_at            timestamptz not null default now()
);

create index wire_topups_account_idx on public.wire_topups (account_id, created_at desc);
create index wire_topups_status_idx  on public.wire_topups (status, expires_at);

alter table public.wire_topups enable row level security;
create policy wire_topups_owner_read on public.wire_topups
  for select to authenticated using (public.user_owns_account(account_id));
-- No insert/update/delete policies: all writes go through the wire-topup-* edge functions (service role).
revoke all on public.wire_topups from anon, authenticated;
grant select on public.wire_topups to authenticated;
grant all on public.wire_topups to service_role;

comment on table public.wire_topups is
  '[SQRZ] Wallet top-up requests paid by bank transfer (USD/EUR). Created by wire-topup-create; credited manually by Will via wire-topup-admin → credit_wire_topup. A pending row past expires_at counts as expired. Account owners can read their own rows; no client writes. See docs/wallet/wire-topup.md.';

-- ─── 4. notifications: allow a "bank transfer received" type ─────────────────
-- subtype = credited dollars as plain text (like wallet_bonus), related_id = wire_topups.id.
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array['campaign_status', 'campaign_ended', 'booking', 'advisor_warning',
                           'chat_request', 'wallet_bonus', 'wire_topup_received']));

-- ─── 5. record_wallet_topup: optional fee override ───────────────────────────
-- Identical to the live function except the new trailing p_fee_cents (default NULL → the card path's
-- hardcoded 7%, exactly as before). The Stripe webhook's call (named args, 5 params) is unaffected.
-- DROP first: adding a defaulted param via CREATE OR REPLACE would leave two overloads and make the
-- webhook's call ambiguous. ACL restored to service_role only, as before.
drop function public.record_wallet_topup(uuid, bigint, text, text, text);

create function public.record_wallet_topup(
  p_profile_id uuid,
  p_amount_cents bigint,
  p_source text,
  p_stripe_payment_intent_id text,
  p_stripe_mode text default 'live'::text,
  p_fee_cents bigint default null
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

  insert into wallet_ledger_entries
    (profile_id, account_id, amount_cents, entry_type, source, stripe_payment_intent_id, stripe_mode)
  values
    (p_profile_id, v_account_id, p_amount_cents, 'topup', p_source, p_stripe_payment_intent_id, v_mode)
  on conflict (stripe_payment_intent_id) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    return null;
  end if;

  v_fee_cents := coalesce(p_fee_cents, round(p_amount_cents * 0.07));
  insert into management_fee_charges (profile_id, wallet_ledger_entry_id, amount_cents, status, stripe_mode)
    values (p_profile_id, v_ledger_id, v_fee_cents, 'pending', v_mode);

  return v_ledger_id;
end;
$function$;

revoke all on function public.record_wallet_topup(uuid, bigint, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.record_wallet_topup(uuid, bigint, text, text, text, bigint) to service_role;

-- ─── 6. credit_wire_topup — the one place a transfer gets credited ───────────
-- Called only by wire-topup-admin (service role). Atomic + idempotent: the wire_topups row is locked
-- (FOR UPDATE), a 'received' row returns its existing result without touching the wallet, and the
-- ledger insert is additionally keyed on 'wire:<id>' (unique stripe_payment_intent_id column) so even a
-- bug here could not credit twice.
--
-- Crediting rule: if the received amount equals the quoted transfer amount, credit exactly the quoted
-- amount and fee. Otherwise (short / over / bank charges) credit PRO RATA — the received money,
-- converted to USD at the quoted rate, split in the quoted amount:fee ratio — so what lands in the
-- wallet always matches the money that actually arrived. Late money is fine: pending and expired rows
-- can be credited; cancelled ones cannot.
create function public.credit_wire_topup(
  p_wire_topup_id uuid,
  p_received_cents bigint,
  p_received_by uuid default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  t public.wire_topups%rowtype;
  v_key text;
  v_total_usd bigint;
  v_received_usd bigint;
  v_credit bigint;
  v_fee bigint;
  v_ledger bigint;
  v_dollars text;
begin
  if p_received_cents is null or p_received_cents <= 0 then
    raise exception 'received amount must be positive' using errcode = '22023';
  end if;

  select * into t from public.wire_topups where id = p_wire_topup_id for update;
  if not found then
    raise exception 'wire topup not found' using errcode = 'P0002';
  end if;

  if t.status = 'received' then
    return jsonb_build_object(
      'already_credited', true,
      'ledger_entry_id', t.ledger_entry_id,
      'credited_cents', t.credited_cents,
      'fee_cents', t.credited_fee_cents
    );
  end if;
  if t.status = 'cancelled' then
    raise exception 'wire topup is cancelled' using errcode = '55000';
  end if;

  v_total_usd := t.amount_cents + t.fee_cents;
  v_received_usd := round(p_received_cents * t.fx_rate);
  if p_received_cents = t.transfer_amount_cents then
    v_credit := t.amount_cents;
    v_fee := t.fee_cents;
  else
    v_credit := round(v_received_usd * t.amount_cents::numeric / v_total_usd);
    v_fee := v_received_usd - v_credit;
  end if;
  if v_credit <= 0 then
    raise exception 'received amount is too small to credit' using errcode = '22023';
  end if;

  v_key := 'wire:' || t.id::text;
  v_ledger := public.record_wallet_topup(t.profile_id, v_credit, t.source, v_key, 'live', v_fee);
  if v_ledger is null then
    -- already inserted by an earlier attempt that did not finish updating this row
    select id into v_ledger from public.wallet_ledger_entries where stripe_payment_intent_id = v_key;
  end if;

  update public.wire_topups set
    status = 'received',
    received_amount_cents = p_received_cents,
    received_at = now(),
    received_by = p_received_by,
    credited_cents = v_credit,
    credited_fee_cents = v_fee,
    ledger_entry_id = v_ledger
  where id = t.id;

  v_dollars := case when v_credit % 100 = 0
                    then (v_credit / 100)::text
                    else to_char(v_credit / 100.0, 'FM999999990.00') end;
  insert into public.notifications (profile_id, type, subtype, related_id, push_worthy)
    values (t.profile_id, 'wire_topup_received', v_dollars, t.id, true);

  return jsonb_build_object(
    'already_credited', false,
    'ledger_entry_id', v_ledger,
    'credited_cents', v_credit,
    'fee_cents', v_fee
  );
end;
$function$;

revoke all on function public.credit_wire_topup(uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.credit_wire_topup(uuid, bigint, uuid) to service_role;

commit;
