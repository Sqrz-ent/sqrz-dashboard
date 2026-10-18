-- Multi-profile ownership: one auth login can own multiple profiles.
-- profiles.user_id is the owner; profiles.id stays the FK PK (never equal to
-- auth.users.id, see CLAUDE.md's Critical ID Rules). Every profile has
-- exactly one owner, no roles, no shared access.
--
-- This migration:
--   1. Adds user_owns_profile(p_profile_id) — the new ownership primitive,
--      correct regardless of how many profiles the caller owns.
--   2. Makes get_profile_id_for_user deterministic (oldest-first = "primary"
--      profile) so every existing single-profile caller, and any code that
--      hasn't been updated to pass an explicit profile_id yet, keeps
--      resolving to the same profile it always has.
--   3. Repoints every RLS policy that compared profile_id = get_profile_id_
--      for_user(auth.uid()) (a single-row equality — only ever matched the
--      primary profile) onto user_owns_profile(profile_id) (a per-row check
--      — matches ALL of the caller's profiles).
--   4. Repoints the three id-based profiles policies onto user_id (the
--      actual owner column — comparing auth.uid() = id was always wrong per
--      this project's own ID rules, just happened to be moot while nothing
--      enforced it meaningfully).
--   5. Reworks the SECURITY DEFINER campaign/lead RPCs to derive the acting
--      profile from the row being acted on (+ ownership check) instead of
--      "the caller's one profile".
--   6. Gives get_dashboard_home / get_companion_subscription_status an
--      optional p_profile_id, defaulting to the primary profile when absent
--      — old app builds (iOS TestFlight) that call these with no arguments
--      keep working unchanged.
--
-- Explicitly NOT touched: the "test: open all" policy on profiles (separate
-- decision, left alone per instruction), wallet schema/semantics (wallets
-- stay per-profile), RevenueCat/roles/sharing, web login.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Ownership helper
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.user_owns_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = p_profile_id and user_id = auth.uid()
  );
$$;

comment on function public.user_owns_profile(uuid) is
  'True iff the current auth.uid() owns the given profile. The row-level primitive behind every owner-scoped RLS policy and SECURITY DEFINER RPC — correct for an account that owns any number of profiles.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Deterministic "primary profile" resolution (kept for back-compat)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.get_profile_id_for_user(user_uuid uuid)
returns uuid
language sql
stable
security definer
as $$
  select id from profiles where user_id = user_uuid order by created_at asc limit 1;
$$;

comment on function public.get_profile_id_for_user(uuid) is
  'Returns the oldest (= "primary") profile owned by user_uuid. Back-compat only — new code should pass an explicit profile_id and check user_owns_profile() instead. For a single-profile account this is simply "their profile," unchanged.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. RLS: profile_id = get_profile_id_for_user(auth.uid()) -> user_owns_profile(profile_id)
-- ─────────────────────────────────────────────────────────────────────────

alter policy ad_spend_wallets_owner_read on public.ad_spend_wallets
  using (user_owns_profile(profile_id));

alter policy boost_campaigns_owner on public.boost_campaigns
  using (user_owns_profile(profile_id))
  with check (user_owns_profile(profile_id));

alter policy campaign_budgets_owner_select on public.campaign_budgets
  using (campaign_id in (select id from boost_campaigns where user_owns_profile(profile_id)));

alter policy ios_subscriptions_owner_read on public.ios_subscriptions
  using (user_owns_profile(profile_id));

alter policy leads_owner_select on public.leads
  using (user_owns_profile(profile_id));

alter policy management_fee_charges_owner_read on public.management_fee_charges
  using (user_owns_profile(profile_id));

alter policy notifications_select_own on public.notifications
  using (user_owns_profile(profile_id));

alter policy notifications_update_own on public.notifications
  using (user_owns_profile(profile_id));

alter policy owner_manages_links on public.private_booking_links
  using (user_owns_profile(profile_id))
  with check (user_owns_profile(profile_id));

alter policy "Owner can view own profile advisor runs" on public.profile_advisor_runs
  using (auth.role() = 'service_role' or user_owns_profile(profile_id));

alter policy wallet_ledger_owner_read on public.wallet_ledger_entries
  using (user_owns_profile(profile_id));

-- Not touched, confirmed already safe for multi-profile ownership (they
-- compare via `profile_id IN (select ... where profiles.user_id = auth.uid())`,
-- an IN-subquery that naturally matches every row the caller owns, not a
-- single-row equality): profile_inquiry_threads, profile_services,
-- profile_videos, shop_products, profile_references, campaign_advisor_runs.

-- ─────────────────────────────────────────────────────────────────────────
-- 4. profiles table: id -> user_id (the actual owner column)
-- ─────────────────────────────────────────────────────────────────────────
-- "test: open all" is left untouched — separate decision, not in scope here.

alter policy profiles_insert_on_signup on public.profiles
  with check (user_id = auth.uid());

alter policy profiles_owner_read on public.profiles
  using (user_id = auth.uid());

alter policy profiles_owner_update on public.profiles
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────
-- 5. SECURITY DEFINER RPCs: derive the acting profile from the row being
--    acted on + verify ownership, instead of "the caller's one profile".
-- ─────────────────────────────────────────────────────────────────────────

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
begin
  if p_amount_cents < 1000 then
    raise exception 'minimum allocation is $10';
  end if;

  select profile_id into v_profile_id from boost_campaigns where id = p_campaign_id;
  if v_profile_id is null or not user_owns_profile(v_profile_id) then
    raise exception 'campaign not found';
  end if;

  select balance_cents into v_balance from ad_spend_wallets where profile_id = v_profile_id;
  if coalesce(v_balance, 0) < p_amount_cents then raise exception 'insufficient wallet balance'; end if;

  insert into campaign_budgets (campaign_id) values (p_campaign_id) on conflict (campaign_id) do nothing;
  select status into v_status from campaign_budgets where campaign_id = p_campaign_id;

  if v_status = 'exhausted' then
    update campaign_budgets set status = 'active', updated_at = now()
     where campaign_id = p_campaign_id;
  end if;
  update boost_campaigns set status = 'pending', status_updated_at = now()
   where id = p_campaign_id and status = 'completed';

  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id, stripe_mode)
    values (v_profile_id, -p_amount_cents, 'allocation', v_src, p_campaign_id, v_mode);
end;
$function$;

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
  v_unspent bigint;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
begin
  if p_amount_cents <= 0 then raise exception 'amount must be positive'; end if;

  select profile_id into v_profile_id from boost_campaigns where id = p_campaign_id;
  if v_profile_id is null or not user_owns_profile(v_profile_id) then
    raise exception 'campaign not found';
  end if;

  select (allocated_cents - spent_cents) into v_unspent from campaign_budgets where campaign_id = p_campaign_id;
  if v_unspent is null then raise exception 'no budget allocated'; end if;
  if p_amount_cents > v_unspent then raise exception 'amount exceeds unspent budget'; end if;

  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (v_profile_id, p_amount_cents, 'deallocation', v_src, p_campaign_id);
end;
$function$;

-- NOTE beyond the literal ask: reallocate moves money between two campaigns'
-- budgets, but that money only ever comes from/returns to ONE profile's
-- wallet (wallets are explicitly out of scope / staying per-profile this
-- pass). The original implementation assumed a single caller profile for
-- both legs; with multi-profile ownership, p_from_campaign_id and
-- p_to_campaign_id could now belong to two DIFFERENT profiles the same
-- login owns. Silently allowing that would let one profile's wallet fund
-- another profile's campaign, which breaks the per-profile wallet
-- invariant. Added an explicit same-profile check for both legs rather than
-- assume it away.
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
  v_to_profile_id uuid;
  v_unspent bigint;
  v_to_status text;
  v_src text := case when p_source in ('web','ios') then p_source else 'ios' end;
begin
  if p_amount_cents <= 0 then raise exception 'amount must be positive'; end if;
  if p_from_campaign_id = p_to_campaign_id then raise exception 'source and destination must differ'; end if;

  select profile_id into v_from_profile_id from boost_campaigns where id = p_from_campaign_id;
  if v_from_profile_id is null or not user_owns_profile(v_from_profile_id) then
    raise exception 'source campaign not found';
  end if;

  select profile_id into v_to_profile_id from boost_campaigns where id = p_to_campaign_id;
  if v_to_profile_id is null or not user_owns_profile(v_to_profile_id) then
    raise exception 'destination campaign not found';
  end if;

  if v_from_profile_id <> v_to_profile_id then
    raise exception 'source and destination campaigns must belong to the same profile';
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
    values (v_from_profile_id, p_amount_cents, 'deallocation', v_src, p_from_campaign_id);
  insert into wallet_ledger_entries (profile_id, amount_cents, entry_type, source, campaign_id)
    values (v_to_profile_id, -p_amount_cents, 'allocation', v_src, p_to_campaign_id);
end;
$function$;

create or replace function public.set_lead_status(p_lead_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
begin
  if p_status not in ('active','archived') then raise exception 'invalid status'; end if;

  select profile_id into v_profile_id from leads where id = p_lead_id;
  if v_profile_id is null or not user_owns_profile(v_profile_id) then
    raise exception 'lead not found';
  end if;

  update leads set status = p_status where id = p_lead_id;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. get_dashboard_home / get_companion_subscription_status: optional
--    p_profile_id, falling back to the primary profile when omitted so
--    existing/old-build callers (incl. the current TestFlight build, which
--    calls both with zero arguments) behave exactly as before.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.get_dashboard_home(p_profile_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
begin
  if p_profile_id is not null then
    if not user_owns_profile(p_profile_id) then
      raise exception 'not authorized';
    end if;
    v_profile_id := p_profile_id;
  else
    v_profile_id := get_profile_id_for_user(auth.uid());
  end if;

  return (
    select jsonb_build_object(
      'profile', to_jsonb(p),
      'hasServices',  exists(select 1 from profile_services  where profile_id = p.id),
      'hasVideos',    exists(select 1 from profile_videos    where profile_id = p.id),
      'hasRefs',      false,
      'planName', (select pl.name from plans pl where pl.id = p.plan_id limit 1)
    )
    from profiles p
    where p.id = v_profile_id
  );
end;
$function$;

create or replace function public.get_companion_subscription_status(p_profile_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
begin
  if p_profile_id is not null then
    if not user_owns_profile(p_profile_id) then
      raise exception 'not authorized';
    end if;
    v_profile_id := p_profile_id;
  else
    v_profile_id := get_profile_id_for_user(auth.uid());
  end if;

  return coalesce(
    (
      select jsonb_build_object(
        'active',
          s.status in ('active', 'in_grace_period')
          and (s.current_period_expires_at is null or s.current_period_expires_at > now()),
        'status', s.status,
        'expires_at', s.current_period_expires_at,
        'product_id', s.product_id
      )
      from ios_subscriptions s
      where s.profile_id = v_profile_id
      order by s.current_period_expires_at desc nulls last
      limit 1
    ),
    jsonb_build_object('active', false, 'status', null, 'expires_at', null, 'product_id', null)
  );
end;
$function$;
