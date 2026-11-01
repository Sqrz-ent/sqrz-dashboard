-- Analytics access lockdown (2026-10-26).
-- Verified before applying: get_analytics_page / get_profile_analytics /
-- get_boost_campaign_native_stats were SECURITY DEFINER with no ownership
-- check and executable by anon, so the public key could read any artist's
-- analytics (incl. Boost spend). profile_analytics (owner-rights view, no
-- RLS) was readable by anon. profile_views accepted inserts from anon.
--
-- Callers that must keep working: the iOS app (signed-in owner, own profile)
-- and server code using the service-role key (campaign-advisor,
-- profile-advisor, refresh-stats, dashboard home). All profile_views writes
-- go through the profile pages' /api/track-view with the service role.
--
-- Tested before applying, in a rolled-back transaction: 16/16 checks passed
-- (owner incl. a 2nd profile on the same account → allowed; another account
-- → 42501; anon → 42501 for all three RPCs, the view, the __unchecked
-- functions and profile_views inserts; service_role → allowed everywhere).
--
-- Approach: each function's original body is kept untouched under a
-- __unchecked name nobody can call; the public name becomes a thin wrapper
-- that checks access first. Access = the caller owns the profile, or the
-- request uses the service role, or it's a direct DB session (postgres /
-- supabase_admin with no JWT — SQL editor, pg_cron).

create or replace function public.can_read_profile_analytics(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or (auth.role() is null and session_user in ('postgres', 'supabase_admin'))
      or public.user_owns_profile(p_profile_id);
$$;
revoke all on function public.can_read_profile_analytics(uuid) from public, anon;

-- ── get_analytics_page ──────────────────────────────────────────────────────
alter function public.get_analytics_page(uuid, integer) rename to get_analytics_page__unchecked;
revoke all on function public.get_analytics_page__unchecked(uuid, integer) from public, anon, authenticated;

create function public.get_analytics_page(p_profile_id uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.can_read_profile_analytics(p_profile_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return public.get_analytics_page__unchecked(p_profile_id, p_days);
end;
$$;
revoke all on function public.get_analytics_page(uuid, integer) from public, anon;
grant execute on function public.get_analytics_page(uuid, integer) to authenticated, service_role;

-- ── get_profile_analytics ───────────────────────────────────────────────────
alter function public.get_profile_analytics(uuid, integer) rename to get_profile_analytics__unchecked;
revoke all on function public.get_profile_analytics__unchecked(uuid, integer) from public, anon, authenticated;

create function public.get_profile_analytics(p_profile_id uuid, p_days integer)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.can_read_profile_analytics(p_profile_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return public.get_profile_analytics__unchecked(p_profile_id, p_days);
end;
$$;
revoke all on function public.get_profile_analytics(uuid, integer) from public, anon;
grant execute on function public.get_profile_analytics(uuid, integer) to authenticated, service_role;

-- ── get_boost_campaign_native_stats ─────────────────────────────────────────
alter function public.get_boost_campaign_native_stats(uuid) rename to get_boost_campaign_native_stats__unchecked;
revoke all on function public.get_boost_campaign_native_stats__unchecked(uuid) from public, anon, authenticated;

create function public.get_boost_campaign_native_stats(p_campaign_id uuid)
returns table(views_driven bigint, ctas_clicked bigint, booking_flow_opens bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_profile_id uuid;
begin
  select profile_id into v_profile_id from public.boost_campaigns where id = p_campaign_id;
  if v_profile_id is null or not public.can_read_profile_analytics(v_profile_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query select * from public.get_boost_campaign_native_stats__unchecked(p_campaign_id);
end;
$$;
revoke all on function public.get_boost_campaign_native_stats(uuid) from public, anon;
grant execute on function public.get_boost_campaign_native_stats(uuid) to authenticated, service_role;

-- ── profile_analytics view: service role only (profile-advisor) ────────────
revoke all on public.profile_analytics from anon, authenticated;

-- ── profile_views: no client writes ─────────────────────────────────────────
-- Revoking the table privileges is what blocks client inserts. The old
-- anon_inserts_views policy is left in place: without INSERT privilege it can
-- no longer take effect (verified — anon insert fails with 42501).
revoke insert, update, delete, truncate on public.profile_views from anon, authenticated;
