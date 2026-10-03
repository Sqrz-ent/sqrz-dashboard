-- Atomic record of an invite-code redemption, called from the redeem-invite-code
-- edge function AFTER RevenueCat's promotional-entitlement grant has already
-- succeeded. Inserts the redemption row and bumps invite_codes.redemption_count
-- in one transaction, so two concurrent redeem calls for the same (code,
-- rc_app_user_id) — a double-tap retry — can never double-count: the unique
-- constraint on invite_code_redemptions(code, rc_app_user_id) makes the INSERT
-- a no-op on the second call, and FOUND (true only when a row was actually
-- inserted) gates whether redemption_count increments at all.
--
-- service_role only — same pattern as record_wallet_topup. Both invite_codes
-- and invite_code_redemptions have RLS enabled with zero policies.
create or replace function public.record_invite_code_redemption(
  p_code text,
  p_rc_app_user_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into invite_code_redemptions (code, rc_app_user_id)
  values (p_code, p_rc_app_user_id)
  on conflict (code, rc_app_user_id) do nothing;

  if found then
    update invite_codes
    set redemption_count = redemption_count + 1
    where code = p_code;
  end if;
end;
$$;

revoke all on function public.record_invite_code_redemption(text, text) from public;
grant execute on function public.record_invite_code_redemption(text, text) to service_role;
