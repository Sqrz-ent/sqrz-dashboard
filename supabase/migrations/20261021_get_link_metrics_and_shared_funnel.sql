-- Shared funnel-builder (2026-10-21) — factored out of get_campaign_metrics
-- unchanged, so get_campaign_metrics and the new get_link_metrics can never
-- drift apart on funnel stages/rules. Same stages/omission rules as before:
-- Arrived always included; Looked around/Engaged/Acted/Converted included
-- only if non-empty; every row value is unique-session-counted off the
-- caller-supplied session id array. Internal helper, not for direct client
-- calls — no ownership check lives here, the two outer RPCs do that before
-- calling in.
create or replace function public.build_engagement_funnel(
  p_session_ids text[],
  p_people integer,
  p_converted_count integer
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_visits integer := coalesce(array_length(p_session_ids, 1), 0);
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
  v_arrived jsonb := '[]'::jsonb;
  v_looked jsonb := '[]'::jsonb;
  v_engaged jsonb := '[]'::jsonb;
  v_acted jsonb := '[]'::jsonb;
  v_converted jsonb := '[]'::jsonb;
  v_funnel jsonb;
begin
  select count(distinct je.session_id) into v_scrolled
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'page_exit'
    and (je.event_properties->>'max_scroll_depth_pct')::numeric > 0;

  select count(distinct je.session_id) into v_saw_content
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'widget_visible';

  select round(avg((je.event_properties->>'time_on_page_seconds')::numeric))
    into v_avg_time_on_page
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'page_exit'
    and je.event_properties->>'time_on_page_seconds' is not null;

  select count(distinct je.session_id) into v_played_video
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'widget_play';

  select count(distinct je.session_id) into v_reached_50
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'widget_progress'
    and (je.event_properties->>'milestone_pct')::numeric = 50;

  select count(distinct je.session_id) into v_reached_75
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'widget_progress'
    and (je.event_properties->>'milestone_pct')::numeric = 75;

  select count(distinct je.session_id) into v_watched_end
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'widget_finish';

  select count(distinct je.session_id) into v_tapped_button
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'cta_click';

  select count(distinct je.session_id) into v_opened_another_page
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'external_link_clicked'
    and je.event_properties->>'destination' = 'page';

  select count(distinct je.session_id) into v_tapped_external_link
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'external_link_clicked'
    and je.event_properties->>'destination' is distinct from 'page';

  select count(distinct je.session_id) into v_opened_booking
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'booking_modal_open';

  select count(distinct je.session_id) into v_tapped_service
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'service_click';

  select count(distinct je.session_id) into v_opened_chat
  from jitsu_events je
  where je.session_id = any(p_session_ids)
    and je.event_type = 'chat_opened';

  if v_visits > 0 then
    v_arrived := v_arrived || jsonb_build_array(jsonb_build_object('key', 'visits', 'label', 'Visits', 'value', v_visits::text));
  end if;
  if coalesce(p_people, 0) > 0 then
    v_arrived := v_arrived || jsonb_build_array(jsonb_build_object('key', 'people', 'label', 'People', 'value', p_people::text));
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

  if coalesce(p_converted_count, 0) > 0 then
    v_converted := v_converted || jsonb_build_array(jsonb_build_object('key', 'converted_leads', 'label', 'Booking requests/inquiries', 'value', p_converted_count::text));
  end if;

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

  return v_funnel;
end;
$function$;

revoke all on function public.build_engagement_funnel(text[], integer, integer) from public;

-- get_campaign_metrics rewritten to call the shared helper — output
-- verified byte-identical to before this refactor against a real campaign
-- (GCMN's "Womex", e3224429-81d0-4033-88ae-7e8e28e9e488). meta/sqrz
-- sections and the ownership/not-found error shape are untouched.
create or replace function public.get_campaign_metrics(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  v_converted_leads integer;
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

  select count(*) into v_converted_leads
  from leads
  where campaign_id = p_campaign_id;

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
    'funnel', build_engagement_funnel(v_session_ids, v_people, v_converted_leads)
  );
end;
$function$;

-- get_link_metrics (new) — same funnel via the shared helper, plus a
-- "Where they came from" breakdown. No link-scoped lead/conversion table
-- exists (link_leads was dropped 2026-08-09), so Converted is always passed
-- 0 here — build_engagement_funnel's own "omit empty stages" rule drops it
-- from the output exactly as it would for a campaign with zero leads; not a
-- special case written for links.
--
-- Source classification (verified against GCMN's real /womex link data):
-- utm_source (explicit tag) takes priority over referrer; Direct means no
-- signal at all (no utm_source AND no referrer, or only a same-site
-- referrer — internal navigation); anything that matches a known
-- platform's referrer domain is classified even when utm_source itself is
-- unset or malformed (a real case hit live: utm_source literally
-- "{{site_source_name}}", an unsubstituted Meta ad template variable —
-- correctly classified as Instagram off its referrer, instagram.com,
-- rather than echoed verbatim or dumped in Other). Only traffic matching
-- neither utm_source nor referrer against a known platform, and not
-- Direct-eligible, lands in Other.
create or replace function public.get_link_metrics(p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
  v_session_ids text[];
  v_people integer;
  v_sources jsonb;
  v_funnel jsonb;
begin
  select profile_id into v_profile_id
  from private_booking_links
  where id = p_link_id;

  if v_profile_id is null then
    raise exception 'link not found' using errcode = 'P0002';
  end if;

  if not user_owns_profile(v_profile_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select array_agg(distinct session_id) into v_session_ids
  from profile_views
  where link_id = p_link_id
    and session_id is not null;

  select count(distinct visitor_fingerprint) into v_people
  from profile_views
  where link_id = p_link_id
    and visitor_fingerprint is not null;

  -- Top 5 sources by unique sessions. A GROUP BY never produces a
  -- zero-count group, so there's nothing left to explicitly filter for
  -- "omit zeros" beyond this.
  select coalesce(jsonb_agg(jsonb_build_object('source', source, 'visits', visits) order by visits desc), '[]'::jsonb)
    into v_sources
  from (
    select
      case
        when lower(coalesce(pv.utm_source, '')) in ('ig', 'instagram') then 'Instagram'
        when lower(coalesce(pv.utm_source, '')) in ('fb', 'facebook') then 'Facebook'
        when lower(coalesce(pv.utm_source, '')) in ('google', 'ga') then 'Google'
        when lower(coalesce(pv.utm_source, '')) in ('tiktok', 'tt') then 'TikTok'
        when pv.referrer ilike '%instagram.com%' then 'Instagram'
        when pv.referrer ilike '%facebook.com%' then 'Facebook'
        when pv.referrer ilike '%google.%' then 'Google'
        when pv.referrer ilike '%tiktok.com%' then 'TikTok'
        when pv.referrer ilike '%twitter.com%' or pv.referrer ilike '%x.com%' then 'Twitter/X'
        when pv.referrer ilike '%linkedin.com%' then 'LinkedIn'
        when pv.referrer ilike '%youtube.com%' then 'YouTube'
        when (pv.utm_source is null or pv.utm_source = '')
             and (pv.referrer is null or pv.referrer = '' or pv.referrer ilike '%sqrz.com%')
          then 'Direct'
        else 'Other'
      end as source,
      count(distinct pv.session_id) as visits
    from profile_views pv
    where pv.link_id = p_link_id
    group by 1
    order by 2 desc
    limit 5
  ) ranked;

  v_funnel := build_engagement_funnel(v_session_ids, v_people, 0);

  return jsonb_build_object(
    'link_id', p_link_id,
    'sources', v_sources,
    'funnel', v_funnel
  );
end;
$function$;
