-- Campaign activation via a consumable in-app purchase, priced per template
-- (2026-10-21). See sqrz-ios's `verify-campaign-activation`/`apple-consumable-
-- webhook` edge functions for how these are written. Does NOT touch wallet
-- top-up, allocate_campaign_budget, meta-campaign-create, or
-- api/campaigns/checkout — this is a separate money flow (paying to submit a
-- campaign at all, not ad spend).

-- Template → product mapping, kept in ONE place so a template can be
-- repointed to another product without a code change. `goal` matches
-- boost_campaigns.goal ('visibility' = Awareness template, 'bookings' =
-- Traffic template). World-readable — not sensitive, every client needs to
-- resolve "which product do I charge for this campaign's template."
create table if not exists campaign_activation_products (
  goal text primary key,
  product_id text not null unique,
  created_at timestamptz not null default now()
);

alter table campaign_activation_products enable row level security;

create policy campaign_activation_products_read_all
  on campaign_activation_products
  for select
  using (true);

insert into campaign_activation_products (goal, product_id) values
  ('visibility', 'com.sqrz.ios.activation.template_01'),
  ('bookings', 'com.sqrz.ios.activation.template_02')
on conflict (goal) do nothing;

-- One row per consumable-IAP activation purchase.
create table if not exists campaign_activations (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references boost_campaigns(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  product_id text not null,
  transaction_id text not null unique,
  original_transaction_id text,
  environment text not null check (environment in ('sandbox', 'production')),
  price numeric,
  currency text,
  status text not null default 'active' check (status in ('active', 'refunded')),
  purchased_at timestamptz not null,
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists campaign_activations_campaign_id_idx
  on campaign_activations (campaign_id);

alter table campaign_activations enable row level security;

create policy campaign_activations_owner_select
  on campaign_activations
  for select
  using (user_owns_profile(profile_id));

-- Writes only via edge functions (verify-campaign-activation,
-- apple-consumable-webhook), both using the service-role client — no owner-
-- write policy exists, matching e.g. wallet_ledger_entries' convention.

-- Records the purchase and advances the campaign through the exact same
-- booked/needs_changes → in_review transition BoostContentSheet's own
-- "Submit" button already performs (which is what
-- on_boost_campaign_submit_meta_create fires off, unchanged). Anything other
-- than a draft-like status means the campaign already moved on some other
-- path — a no-op (campaign_advanced: false in the result), not an error, so
-- the purchase is never lost even if the status raced ahead in the meantime.
create or replace function record_campaign_activation(
  p_campaign_id uuid,
  p_profile_id uuid,
  p_product_id text,
  p_transaction_id text,
  p_original_transaction_id text,
  p_environment text,
  p_price numeric,
  p_currency text,
  p_purchased_at timestamptz
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
  insert into campaign_activations (
    campaign_id, profile_id, product_id, transaction_id, original_transaction_id,
    environment, price, currency, status, purchased_at
  ) values (
    p_campaign_id, p_profile_id, p_product_id, p_transaction_id, p_original_transaction_id,
    p_environment, p_price, p_currency, 'active', p_purchased_at
  )
  returning id into v_activation_id;

  update boost_campaigns
  set status = 'in_review', status_updated_at = now()
  where id = p_campaign_id
    and status in ('booked', 'needs_changes');
  get diagnostics v_updated_rows = row_count;

  return jsonb_build_object(
    'activation_id', v_activation_id,
    'campaign_advanced', v_updated_rows > 0
  );
end;
$$;

-- SECURITY DEFINER + bypasses every check the calling edge functions perform
-- (JWS verification, campaign ownership, product-to-template matching) — must
-- only be callable by the service-role key those functions use, never by a
-- client directly via supabase.rpc(...).
revoke all on function record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz) from public;
revoke all on function record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz) from anon;
revoke all on function record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz) from authenticated;
grant execute on function record_campaign_activation(uuid, uuid, text, text, text, text, numeric, text, timestamptz) to service_role;
