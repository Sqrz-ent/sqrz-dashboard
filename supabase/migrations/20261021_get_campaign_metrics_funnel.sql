-- get_campaign_metrics: replace the fixed 'sqrz' benchmarks (stayed over 1
-- minute / opened another page / watched video / tapped button) with a
-- dynamic 'funnel' built from everything SQRZ tracks for the campaign's
-- attributed sessions. Only non-zero/non-null rows are shown; empty stages
-- are dropped except "Arrived" (always present). The Meta section and
-- cost_per_visit/visits (the compact card's key metrics, read via the
-- slimmed-down 'sqrz' object at the same path as before) are unchanged, as
-- is the ownership check.
--
-- Stages, in order:
--   Arrived       — visits (unique sessions), people (unique visitor_fingerprint)
--   Looked around — scrolled (page_exit max_scroll_depth_pct > 0), saw
--                   content (widget_visible), average time on page
--                   (avg page_exit time_on_page_seconds — a VALUE, not a count)
--   Engaged       — played video (widget_play), reached 50%/75%
--                   (widget_progress milestone_pct), watched to the end
--                   (widget_finish)
--   Acted         — tapped a button (cta_click), opened another SQRZ page
--                   (external_link_clicked destination='page'), tapped an
--                   external link (external_link_clicked, any other
--                   destination), opened booking (booking_modal_open),
--                   tapped a service (service_click), opened chat (chat_opened)
--   Converted     — booking requests/inquiries attributable to this campaign.
--                   leads.campaign_id exists (confirmed against the live
--                   schema) — campaign-attributed, not session-attributed
--                   (leads has no session_id column), so this counts
--                   leads.campaign_id = p_campaign_id directly rather than
--                   joining through the session set like every other stage.
--
-- Every row's value is pre-formatted as TEXT by this function (counts as
-- plain digit strings, the time average as e.g. "28s") so the iOS metrics
-- sheet can render whatever comes back with no per-metric formatting logic
-- of its own — "no hardcoded rows."

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
  v_people integer;

  v_scrolled integer;
  v_saw_content integer;
  v_avg_time_on_page numeric;

  v_played_video integer;
  v_reached_50 integer;
  v_reached_75 integer;
  v_watched_end integer;

  v_tapped_button integer;
  v_opened_another_page integer;
  v_tapped_external_link integer;
  v_opened_booking integer;
  v_tapped_service integer;
  v_opened_chat integer;

  v_converted_leads integer;

  v_arrived jsonb := '[]'::jsonb;
  v_looked jsonb := '[]'::jsonb;
  v_engaged jsonb := '[]'::jsonb;
  v_acted jsonb := '[]'::jsonb;
  v_converted jsonb := '[]'::jsonb;
  v_funnel jsonb;
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
  -- join key into jitsu_events for every funnel stage except Converted.
  select array_agg(distinct session_id) into v_session_ids
  from profile_views
  where boost_campaign_id = p_campaign_id
    and session_id is not null;

  v_visits := coalesce(array_length(v_session_ids, 1), 0);
  v_cost_per_visit := case when v_visits > 0
    then round(v_spend / v_visits, 4) else null end;

  select count(distinct visitor_fingerprint) into v_people
  from profile_views
  where boost_campaign_id = p_campaign_id
    and visitor_fingerprint is not null;

  -- Looked around
  select count(distinct je.session_id) into v_scrolled
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'page_exit'
    and (je.event_properties->>'max_scroll_depth_pct')::numeric > 0;

  select count(distinct je.session_id) into v_saw_content
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'widget_visible';

  -- A value, not a count — averaged over matching page_exit EVENTS (not
  -- deduped by session), rounded to whole seconds.
  select round(avg((je.event_properties->>'time_on_page_seconds')::numeric))
    into v_avg_time_on_page
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'page_exit'
    and je.event_properties->>'time_on_page_seconds' is not null;

  -- Engaged
  select count(distinct je.session_id) into v_played_video
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'widget_play';

  select count(distinct je.session_id) into v_reached_50
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'widget_progress'
    and (je.event_properties->>'milestone_pct')::numeric = 50;

  select count(distinct je.session_id) into v_reached_75
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'widget_progress'
    and (je.event_properties->>'milestone_pct')::numeric = 75;

  select count(distinct je.session_id) into v_watched_end
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'widget_finish';

  -- Acted
  select count(distinct je.session_id) into v_tapped_button
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'cta_click';

  select count(distinct je.session_id) into v_opened_another_page
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'external_link_clicked'
    and je.event_properties->>'destination' = 'page';

  select count(distinct je.session_id) into v_tapped_external_link
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'external_link_clicked'
    and je.event_properties->>'destination' is distinct from 'page';

  select count(distinct je.session_id) into v_opened_booking
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'booking_modal_open';

  select count(distinct je.session_id) into v_tapped_service
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'service_click';

  select count(distinct je.session_id) into v_opened_chat
  from jitsu_events je
  where je.session_id = any(v_session_ids)
    and je.event_type = 'chat_opened';

  -- Converted — campaign-attributed (leads.campaign_id), not session-
  -- attributed (leads has no session_id column).
  select count(*) into v_converted_leads
  from leads
  where campaign_id = p_campaign_id;

  -- Build rows, omitting any with a 0 or null value.
  if v_visits > 0 then
    v_arrived := v_arrived || jsonb_build_array(jsonb_build_object('key', 'visits', 'label', 'Visits', 'value', v_visits::text));
  end if;
  if coalesce(v_people, 0) > 0 then
    v_arrived := v_arrived || jsonb_build_array(jsonb_build_object('key', 'people', 'label', 'People', 'value', v_people::text));
  end if;

  if coalesce(v_scrolled, 0) > 0 then
    v_looked := v_looked || jsonb_build_array(jsonb_build_object('key', 'scrolled', 'label', 'Scrolled', 'value', v_scrolled::text));
  end if;
  if coalesce(v_saw_content, 0) > 0 then
    v_looked := v_looked || jsonb_build_array(jsonb_build_object('key', 'saw_content', 'label', 'Saw content', 'value', v_saw_content::text));
  end if;
  if coalesce(v_avg_time_on_page, 0) > 0 then
    v_looked := v_looked || jsonb_build_array(jsonb_build_object('key', 'avg_time_on_page', 'label', 'Average time on page', 'value', v_avg_time_on_page::int::text || 's'));
  end if;

  if coalesce(v_played_video, 0) > 0 then
    v_engaged := v_engaged || jsonb_build_array(jsonb_build_object('key', 'played_video', 'label', 'Played video', 'value', v_played_video::text));
  end if;
  if coalesce(v_reached_50, 0) > 0 then
    v_engaged := v_engaged || jsonb_build_array(jsonb_build_object('key', 'reached_50', 'label', 'Reached 50%', 'value', v_reached_50::text));
  end if;
  if coalesce(v_reached_75, 0) > 0 then
    v_engaged := v_engaged || jsonb_build_array(jsonb_build_object('key', 'reached_75', 'label', 'Reached 75%', 'value', v_reached_75::text));
  end if;
  if coalesce(v_watched_end, 0) > 0 then
    v_engaged := v_engaged || jsonb_build_array(jsonb_build_object('key', 'watched_end', 'label', 'Watched to the end', 'value', v_watched_end::text));
  end if;

  if coalesce(v_tapped_button, 0) > 0 then
    v_acted := v_acted || jsonb_build_array(jsonb_build_object('key', 'tapped_button', 'label', 'Tapped a button', 'value', v_tapped_button::text));
  end if;
  if coalesce(v_opened_another_page, 0) > 0 then
    v_acted := v_acted || jsonb_build_array(jsonb_build_object('key', 'opened_another_page', 'label', 'Opened another page', 'value', v_opened_another_page::text));
  end if;
  if coalesce(v_tapped_external_link, 0) > 0 then
    v_acted := v_acted || jsonb_build_array(jsonb_build_object('key', 'tapped_external_link', 'label', 'Tapped an external link', 'value', v_tapped_external_link::text));
  end if;
  if coalesce(v_opened_booking, 0) > 0 then
    v_acted := v_acted || jsonb_build_array(jsonb_build_object('key', 'opened_booking', 'label', 'Opened booking', 'value', v_opened_booking::text));
  end if;
  if coalesce(v_tapped_service, 0) > 0 then
    v_acted := v_acted || jsonb_build_array(jsonb_build_object('key', 'tapped_service', 'label', 'Tapped a service', 'value', v_tapped_service::text));
  end if;
  if coalesce(v_opened_chat, 0) > 0 then
    v_acted := v_acted || jsonb_build_array(jsonb_build_object('key', 'opened_chat', 'label', 'Opened chat', 'value', v_opened_chat::text));
  end if;

  if coalesce(v_converted_leads, 0) > 0 then
    v_converted := v_converted || jsonb_build_array(jsonb_build_object('key', 'converted_leads', 'label', 'Booking requests/inquiries', 'value', v_converted_leads::text));
  end if;

  -- Assemble stages — Arrived always included; every other stage only if
  -- it ended up with at least one row.
  v_funnel := jsonb_build_array(jsonb_build_object('stage', 'Arrived', 'rows', v_arrived));
  if jsonb_array_length(v_looked) > 0 then
    v_funnel := v_funnel || jsonb_build_array(jsonb_build_object('stage', 'Looked around', 'rows', v_looked));
  end if;
  if jsonb_array_length(v_engaged) > 0 then
    v_funnel := v_funnel || jsonb_build_array(jsonb_build_object('stage', 'Engaged', 'rows', v_engaged));
  end if;
  if jsonb_array_length(v_acted) > 0 then
    v_funnel := v_funnel || jsonb_build_array(jsonb_build_object('stage', 'Acted', 'rows', v_acted));
  end if;
  if jsonb_array_length(v_converted) > 0 then
    v_funnel := v_funnel || jsonb_build_array(jsonb_build_object('stage', 'Converted', 'rows', v_converted));
  end if;

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
      'cost_per_visit', v_cost_per_visit
    ),
    'funnel', v_funnel
  );
end;
$$;
