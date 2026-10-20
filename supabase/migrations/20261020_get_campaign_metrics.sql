-- get_campaign_metrics(p_campaign_id uuid) — Meta + SQRZ-native engagement
-- metrics for one campaign, for the iOS "More info" metrics helper sheet
-- (starting with Traffic/goal='bookings' cards; the RPC itself is goal-
-- agnostic, gating is a UI-only decision).
--
-- Meta section: read straight off boost_campaigns.stat_* (already synced by
-- meta-insights-sync). cost_per_link_click is computed here as
-- spend / link_clicks rather than reused from stat_cost_per_click — that
-- column is Meta's generic cpc (cost per ANY click), not specifically link
-- clicks, which would misname the metric. "Landing page views" was asked for
-- "if stored" — boost_campaigns has no such column (confirmed against the
-- live schema before writing this), so it's omitted entirely rather than
-- faked.
--
-- SQRZ section: visits = unique session_ids from profile_views rows
-- attributed to this campaign (boost_campaign_id = p_campaign_id). Every
-- engagement metric below counts UNIQUE SESSIONS (not raw events) from
-- jitsu_events whose session_id is one of those same sessions:
--   stayed_over_1_min    — page_exit, time_on_page_seconds >= 60
--   opened_another_page  — session has >1 page_view, OR an
--                          external_link_clicked with destination='page'
--   watched_video        — widget_play (any occurrence)
--   tapped_button        — cta_click, external_link_clicked, or
--                          booking_modal_open (any occurrence)
--
-- Ownership: user_owns_profile(campaign.profile_id) — raises if the caller
-- doesn't own the campaign's profile. SECURITY DEFINER (needs to read
-- profile_views/jitsu_events across RLS the same way get_analytics_page does),
-- granted to authenticated only.
--
-- Verified live before writing this file (rolled-back/no-op reads only):
-- the owning user (auth b6ee75dc-...) gets real numbers for campaign
-- e3224429-81d0-4033-88ae-7e8e28e9e488 ("Womex", GCMN); a non-owning auth.uid
-- gets a clean "not authorized" exception.

create or replace function public.get_campaign_metrics(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_profile_id uuid;
  v_spend numeric;
  v_link_clicks integer;
  v_reach integer;
  v_impressions integer;
  v_cost_per_link_click numeric;
  v_session_ids text[];
  v_visits integer;
  v_cost_per_visit numeric;
  v_stayed integer;
  v_opened_another_page integer;
  v_watched_video integer;
  v_tapped_button integer;
begin
  select profile_id, stat_spend, stat_link_clicks, stat_reach, stat_impressions
    into v_profile_id, v_spend, v_link_clicks, v_reach, v_impressions
  from boost_campaigns
  where id = p_campaign_id;

  if v_profile_id is null then
    raise exception 'campaign not found' using errcode = 'P0002';
  end if;

  if not user_owns_profile(v_profile_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_cost_per_link_click := case when coalesce(v_link_clicks, 0) > 0
    then round(v_spend / v_link_clicks, 4) else null end;

  -- Unique sessions from profile_views attributed to this campaign — the
  -- join key into jitsu_events for every SQRZ engagement metric below.
  select array_agg(distinct session_id) into v_session_ids
  from profile_views
  where boost_campaign_id = p_campaign_id
    and session_id is not null;

  v_visits := coalesce(array_length(v_session_ids, 1), 0);
  v_cost_per_visit := case when v_visits > 0
    then round(v_spend / v_visits, 4) else null end;

  select count(distinct je.session_id) into v_stayed
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'page_exit'
    and (je.event_properties->>'time_on_page_seconds')::numeric >= 60;

  select count(distinct s) into v_opened_another_page
  from unnest(coalesce(v_session_ids, array[]::text[])) s
  where (
    select count(*) from jitsu_events je
    where je.session_id = s and je.event_type = 'page_view'
  ) > 1
  or exists (
    select 1 from jitsu_events je
    where je.session_id = s
      and je.event_type = 'external_link_clicked'
      and je.event_properties->>'destination' = 'page'
  );

  select count(distinct je.session_id) into v_watched_video
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'widget_play';

  select count(distinct je.session_id) into v_tapped_button
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type in ('cta_click', 'external_link_clicked', 'booking_modal_open');

  return jsonb_build_object(
    'campaign_id', p_campaign_id,
    'meta', jsonb_build_object(
      'spend', v_spend,
      'link_clicks', v_link_clicks,
      'cost_per_link_click', v_cost_per_link_click,
      'reach', v_reach,
      'impressions', v_impressions
    ),
    'sqrz', jsonb_build_object(
      'visits', v_visits,
      'cost_per_visit', v_cost_per_visit,
      'stayed_over_1_min', v_stayed,
      'opened_another_page', v_opened_another_page,
      'watched_video', v_watched_video,
      'tapped_button', v_tapped_button
    )
  );
end;
$$;

revoke all on function public.get_campaign_metrics(uuid) from public;
grant execute on function public.get_campaign_metrics(uuid) to authenticated;
