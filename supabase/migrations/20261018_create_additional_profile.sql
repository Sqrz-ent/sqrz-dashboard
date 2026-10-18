-- create_additional_profile(p_slug, p_name): lets an already-authenticated
-- login create a second (or Nth) profile on its own account. No grow_access
-- check here — the iOS app only shows "Create profile" to grow_access users
-- via the RevenueCat SDK; this function has no server-side source of truth
-- for that entitlement to check against (see the prior session's note).

insert into public.app_config (key, value)
values ('max_profiles_per_account', '5'::jsonb)
on conflict (key) do nothing;

create or replace function public.create_additional_profile(p_slug text, p_name text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_slug text;
  v_max_profiles int;
  v_profile_count int;
  v_new_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  -- Same rule SignUpViewModel.setSlug applies client-side before it ever
  -- lets the signup "available" check run: lowercase, letters/digits/
  -- hyphen only, length >= 3. Validated here (not silently re-sanitized)
  -- so a slug the client already showed as "available" can't come back
  -- different from what the user actually confirmed.
  v_slug := lower(coalesce(p_slug, ''));
  if v_slug !~ '^[a-z0-9-]+$' or length(v_slug) < 3 then
    raise exception 'invalid_slug';
  end if;

  -- Same uniqueness check the signup flow's availability lookup makes
  -- (profiles.slug is also UNIQUE at the DB level regardless, but this
  -- gives the clear, iOS-mapped error code instead of a raw 23505).
  if exists (select 1 from profiles where slug = v_slug) then
    raise exception 'slug_taken';
  end if;

  -- Cap: at most N profiles per account, in total. app_config.
  -- max_profiles_per_account (added above, default 5) with the same
  -- fallback if the key is ever missing.
  select coalesce(
    (select (value::text)::int from app_config where key = 'max_profiles_per_account'),
    5
  ) into v_max_profiles;

  select count(*) into v_profile_count from profiles where user_id = v_user_id;
  if v_profile_count >= v_max_profiles then
    raise exception 'limit_reached';
  end if;

  -- Same defaults handle_new_user applies on fresh signup (id/user_type),
  -- plus email copied from the auth user the same way handle_new_user
  -- copies NEW.email, plus the one thing handle_new_user has no input for
  -- on a first signup: a display name. account_id is NOT set here — the
  -- existing profiles_set_account_id trigger (BEFORE INSERT) resolves it
  -- from NEW.user_id and lands it on this caller's own account, same as
  -- every other profile they own.
  insert into profiles (id, user_id, email, slug, name, user_type)
  values (gen_random_uuid(), v_user_id, auth.email(), v_slug, p_name, 'member')
  returning id into v_new_id;

  return v_new_id;
end;
$function$;

comment on function public.create_additional_profile(text, text) is
  'Creates an additional profile on the caller''s own account (one login, multiple profiles). No entitlement check here — gated client-side (iOS shows this only to grow_access users). Error codes: invalid_slug, slug_taken, limit_reached (app_config.max_profiles_per_account, default 5).';
