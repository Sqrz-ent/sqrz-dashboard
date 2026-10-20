-- Removes the "once per user per code" rule: a user can redeem the same
-- invite code again (e.g. after accidentally deleting their account, or
-- after losing access). Plain indexes (invite_code_redemptions_code_idx,
-- invite_code_redemptions_rc_app_user_id_idx) and the FK to invite_codes
-- are untouched — only the unique constraint is dropped.
alter table invite_code_redemptions
  drop constraint invite_code_redemptions_code_rc_app_user_id_key;

-- record_invite_code_redemption's `on conflict (code, rc_app_user_id) do
-- nothing` targeted that unique constraint — with it gone, ON CONFLICT has
-- no matching constraint to reference and the call would start erroring.
-- Rewritten as a plain insert + unconditional increment, so a repeat
-- redemption inserts a new row and counts toward max_redemptions exactly
-- like a first redemption (verified in a rolled-back transaction before
-- this migration: redemption_count advanced on every call, including
-- repeats by the same rc_app_user_id).
create or replace function public.record_invite_code_redemption(p_code text, p_rc_app_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into invite_code_redemptions (code, rc_app_user_id)
  values (p_code, p_rc_app_user_id);

  update invite_codes
  set redemption_count = redemption_count + 1
  where code = p_code;
end;
$function$;
