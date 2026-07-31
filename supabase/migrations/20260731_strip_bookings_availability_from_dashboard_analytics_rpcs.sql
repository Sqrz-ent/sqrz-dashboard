-- get_dashboard_home / get_analytics_page still referenced bookings/availability_blocks,
-- both dropped in the leads-only migration — these RPCs would now error on every call.
-- Per explicit decision: remove the booking/availability widgets entirely, no lead-based
-- replacement. Applied via apply_migration on 2026-07-31.

create or replace function public.get_dashboard_home()
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  with current_profile as (
    select * from profiles where user_id = auth.uid() limit 1
  )
  select jsonb_build_object(
    'profile', to_jsonb(p),
    'hasServices',  exists(select 1 from profile_services  where profile_id = p.id),
    'hasVideos',    exists(select 1 from profile_videos    where profile_id = p.id),
    'hasRefs',      exists(select 1 from profile_references where profile_id = p.id),
    'hasGallery',   exists(select 1 from profile_photos    where profile_id = p.id),
    'refCode', (select to_jsonb(rc) from referral_codes rc where rc.owner_id = p.id limit 1),
    'planName', (select pl.name from plans pl where pl.id = p.plan_id limit 1)
  )
  from current_profile p;
$function$;

create or replace function public.get_analytics_page(p_profile_id uuid, p_days integer default 30)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'views_total', (
      select count(*) from profile_views
      where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
    ),
    'views_prev_period', (
      select count(*) from profile_views
      where profile_id = p_profile_id
      and created_at > now() - (p_days * 2 || ' days')::interval
      and created_at <= now() - (p_days || ' days')::interval
    ),
    'unique_visitors', (
      select count(distinct coalesce(visitor_fingerprint, session_id))
      from profile_views
      where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
    ),
    'views_by_day', (
      select coalesce(jsonb_agg(row_to_json(d)), '[]')
      from (
        select date(created_at) as date, count(*) as count
        from profile_views
        where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
        group by date(created_at) order by date asc
      ) d
    ),
    'top_countries', (
      select coalesce(jsonb_agg(row_to_json(c)), '[]')
      from (
        select country_code, count(distinct coalesce(visitor_fingerprint, session_id)) as count
        from profile_views
        where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
        and country_code is not null
        group by country_code order by count desc limit 10
      ) c
    ),
    'top_cities', (
      select coalesce(jsonb_agg(row_to_json(c)), '[]')
      from (
        select city, country_code, count(distinct coalesce(visitor_fingerprint, session_id)) as count
        from profile_views
        where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
        and city is not null
        group by city, country_code order by count desc limit 10
      ) c
    ),
    'top_sources', (
      select coalesce(jsonb_agg(row_to_json(s)), '[]')
      from (
        select
          coalesce(utm_source,
            case
              when referrer ilike '%instagram%' then 'instagram'
              when referrer ilike '%facebook%' then 'facebook'
              when referrer ilike '%twitter%' or referrer ilike '%t.co%' then 'twitter'
              when referrer ilike '%linkedin%' then 'linkedin'
              when referrer ilike '%tiktok%' then 'tiktok'
              when referrer ilike '%youtube%' then 'youtube'
              when referrer is not null then 'referral'
              else 'direct'
            end
          ) as source,
          count(distinct coalesce(visitor_fingerprint, session_id)) as count
        from profile_views
        where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
        group by source order by count desc limit 10
      ) s
    ),
    'chat_opens', (
      select count(*) from jitsu_events
      where profile_id = p_profile_id and event_type = 'chat_opened'
      and created_at > now() - (p_days || ' days')::interval
    ),
    'service_clicks', (
      select count(*) from jitsu_events
      where profile_id = p_profile_id and event_type = 'service_click'
      and created_at > now() - (p_days || ' days')::interval
    ),
    'booking_modal_opens', (
      select count(*) from jitsu_events
      where profile_id = p_profile_id and event_type = 'booking_modal_open'
      and created_at > now() - (p_days || ' days')::interval
    ),
    'external_link_clicks', (
      select count(*) from jitsu_events
      where profile_id = p_profile_id
      and event_type in ('external_link_clicked', 'download_clicked')
      and (event_properties ->> 'destination') is distinct from 'page'
      and created_at > now() - (p_days || ' days')::interval
    ),
    'payment_gate_clicks', (
      select count(*) from jitsu_events
      where profile_id = p_profile_id and event_type = 'payment_gate_clicked'
      and created_at > now() - (p_days || ' days')::interval
    ),
    'payment_gate_unlocks', (
      select count(*) from jitsu_events
      where profile_id = p_profile_id and event_type = 'payment_gate_unlocked'
      and created_at > now() - (p_days || ' days')::interval
    ),
    'requests_sent', (
      select count(*) from jitsu_events
      where profile_id = p_profile_id and event_type = 'booking_request_sent'
      and created_at > now() - (p_days || ' days')::interval
    ),
    'private_links', (
      select coalesce(jsonb_agg(row_to_json(l)), '[]')
      from (
        select
          pbl.id, pbl.title, pbl.link_slug, pbl.page_type, pbl.is_active,
          count(pv.id) as views,
          count(distinct coalesce(pv.visitor_fingerprint, pv.session_id)) as unique_visitors,
          (
            select count(*) from jitsu_events je
            where je.profile_id = p_profile_id
            and je.event_type in ('external_link_clicked', 'download_clicked')
            and (je.event_properties ->> 'link_slug') = pbl.link_slug
            and (je.event_properties ->> 'destination') is distinct from 'page'
            and je.created_at > now() - (p_days || ' days')::interval
          ) as clicks,
          (
            select count(*) from link_leads ll
            where ll.link_id = pbl.id and ll.collected_at > now() - (p_days || ' days')::interval
          ) as leads
        from private_booking_links pbl
        left join profile_views pv
          on pv.link_id = pbl.id and pv.created_at > now() - (p_days || ' days')::interval
        where pbl.profile_id = p_profile_id
        group by pbl.id, pbl.title, pbl.link_slug, pbl.page_type, pbl.is_active
        order by views desc
      ) l
    ),
    'boost_campaigns', (
      select coalesce(jsonb_agg(row_to_json(bc)), '[]')
      from (
        select
          b.id, b.status, b.promote_type, b.budget_amount, b.budget_currency,
          b.starts_at, b.ends_at, b.utm_campaign,
          (select count(*) from jitsu_events je where je.boost_campaign_id = b.id and je.event_type = 'page_view') as driven_views,
          null::bigint as driven_unique,
          'Not measurable — campaign traffic is tracked cookielessly (no per-visitor key)' as driven_unique_reason,
          (select count(*) from jitsu_events je where je.boost_campaign_id = b.id and je.event_type = 'booking_modal_open') as modal_opens,
          (select count(*) from jitsu_events je where je.boost_campaign_id = b.id and je.event_type = 'chat_opened') as chat_opens,
          (select count(*) from jitsu_events je where je.boost_campaign_id = b.id and je.event_type = 'service_click') as service_clicks,
          (select count(*) from jitsu_events je where je.boost_campaign_id = b.id and je.event_type = 'cta_click') as cta_clicks,
          (select count(*) from jitsu_events je where je.boost_campaign_id = b.id and je.event_type = 'widget_visible') as widget_opens,
          b.stat_impressions, b.stat_reach, b.stat_profile_visits, b.stat_link_clicks,
          b.stat_cost_per_click, b.stat_cpm, b.stat_channel_breakdown, b.stat_creative_breakdown
        from boost_campaigns b
        where b.profile_id = p_profile_id
        order by b.starts_at desc nulls last
      ) bc
    ),
    'leads', (
      select coalesce(jsonb_agg(row_to_json(l) order by l.collected_at desc), '[]')
      from (
        select ll.id, ll.collected_at, ll.email, pbl.title as link_title, pbl.link_slug
        from link_leads ll
        left join private_booking_links pbl on pbl.id = ll.link_id
        where ll.profile_id = p_profile_id and ll.collected_at > now() - (p_days || ' days')::interval
        order by ll.collected_at desc limit 50
      ) l
    ),
    'leads_total', (
      select count(*) from link_leads
      where profile_id = p_profile_id and collected_at > now() - (p_days || ' days')::interval
    )
  );
$function$;
