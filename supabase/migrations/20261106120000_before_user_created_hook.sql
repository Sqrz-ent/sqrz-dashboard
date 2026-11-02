-- Before User Created auth hook — only Sign in with Apple may create accounts.
--
-- WHY: web signup is retired and the web login fallback (emailed OTP code, see
-- docs/auth/web-login-fallback.md) must only ever sign in EXISTING users.
-- `shouldCreateUser: false` is a client-side request flag, not a control: anyone
-- holding the publishable key can call the Auth API directly and create a user,
-- and `handle_new_user` would then create a profile for it. This hook closes that
-- at the Auth layer. Turning off "Allow new users to sign up" globally is NOT an
-- option — iOS creates new users through signInWithIdToken (Apple), which that
-- toggle would also block.
--
-- BEHAVIOUR: the hook runs before every new auth.users row is created. It reads
-- the provider from the event and
--   * allows 'apple'
--   * rejects everything else (email OTP/magic link/password signup, phone,
--     anonymous, any other OAuth provider) with HTTP 403.
-- Existing users are unaffected: the hook only fires for NEW users, so signing
-- in with an emailed code, a password, or Apple as an existing user never
-- reaches it.
--
-- NOT ENABLED BY THIS FILE. Creating the function does nothing until it is
-- selected under Dashboard → Authentication → Hooks → "Before User Created"
-- (Postgres function: public.hook_before_user_created). See the checklist in
-- docs/auth/web-login-fallback.md.
--
-- CAVEAT (verify before enabling): Supabase admin-created users (Admin API
-- `inviteUserByEmail` / `createUser` / the dashboard "Invite user" button) are
-- also email-provider creations. If those flows are used anywhere (the
-- /auth/callback comments mention admin-generated invite links), this hook will
-- reject them too. Test the hook with an invite before relying on those flows.
--
-- To allow another provider later, add it to v_allowed_providers below (new
-- migration, CREATE OR REPLACE).

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_allowed_providers constant text[] := array['apple'];
  v_provider  text;
  v_providers jsonb;
begin
  v_provider  := lower(coalesce(event -> 'user' -> 'app_metadata' ->> 'provider', ''));
  v_providers := coalesce(event -> 'user' -> 'app_metadata' -> 'providers', '[]'::jsonb);

  -- Allow when the primary provider is allowlisted, or the user's providers
  -- array contains an allowlisted one (belt and braces for the Apple id-token
  -- path, where both fields are set to 'apple').
  if v_provider = any (v_allowed_providers)
     or exists (
       select 1
       from jsonb_array_elements_text(v_providers) as p(value)
       where lower(p.value) = any (v_allowed_providers)
     )
  then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', 'New accounts are created in the SQRZ iOS app.',
      'http_code', 403
    )
  );
end;
$$;

comment on function public.hook_before_user_created(jsonb) is
  'Supabase Auth "Before User Created" hook: allows only Sign in with Apple to create users; rejects email/phone/anonymous/other signups with 403. Enable under Auth → Hooks.';

-- Grants required for Supabase auth hooks: only supabase_auth_admin may run it;
-- nobody else (the API roles) may call it.
grant usage on schema public to supabase_auth_admin;

grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

revoke execute on function public.hook_before_user_created(jsonb) from authenticated, anon, public;

-- ─── Manual test (run in the SQL editor AFTER applying; not part of the migration)
--   select public.hook_before_user_created('{"user":{"app_metadata":{"provider":"apple","providers":["apple"]}}}');
--     -- expect: {}
--   select public.hook_before_user_created('{"user":{"app_metadata":{"provider":"email","providers":["email"]}}}');
--     -- expect: {"error": {"message": "New accounts are created in the SQRZ iOS app.", "http_code": 403}}
--   select public.hook_before_user_created('{"user":{"app_metadata":{}}}');
--     -- expect: the same 403 error
--   (Run as postgres/service role; anon/authenticated must get "permission denied for function".)
