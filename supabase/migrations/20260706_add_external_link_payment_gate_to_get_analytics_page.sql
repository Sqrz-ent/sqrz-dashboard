-- The Analytics page (_app.analytics.tsx) reads get_analytics_page, NOT the
-- profile_analytics view. To surface the new link-model events there:
--   * replace stale download_clicks with external_link_clicks (consolidated
--     download_clicked + external_link_clicked, excluding destination='page'
--     pill navigations — matches the view + the _app.links.tsx consumer)
--   * add payment_gate_clicks, payment_gate_unlocks
-- Everything else is reproduced verbatim from the existing definition.
CREATE OR REPLACE FUNCTION public.get_analytics_page(p_profile_id uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'views_total', (
      SELECT COUNT(*) FROM profile_views
      WHERE profile_id = p_profile_id
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'views_prev_period', (
      SELECT COUNT(*) FROM profile_views
      WHERE profile_id = p_profile_id
      AND created_at > now() - (p_days * 2 || ' days')::interval
      AND created_at <= now() - (p_days || ' days')::interval
    ),
    'unique_visitors', (
      SELECT COUNT(DISTINCT COALESCE(visitor_fingerprint, session_id))
      FROM profile_views
      WHERE profile_id = p_profile_id
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'booking_requests', (
      SELECT COUNT(*) FROM bookings
      WHERE owner_id = p_profile_id
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'bookings_confirmed', (
      SELECT COUNT(*) FROM bookings
      WHERE owner_id = p_profile_id
      AND status IN ('confirmed', 'completed')
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'views_by_day', (
      SELECT COALESCE(jsonb_agg(row_to_json(d)), '[]')
      FROM (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM profile_views
        WHERE profile_id = p_profile_id
        AND created_at > now() - (p_days || ' days')::interval
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      ) d
    ),
    'top_countries', (
      SELECT COALESCE(jsonb_agg(row_to_json(c)), '[]')
      FROM (
        SELECT country_code,
          COUNT(DISTINCT COALESCE(visitor_fingerprint, session_id)) as count
        FROM profile_views
        WHERE profile_id = p_profile_id
        AND created_at > now() - (p_days || ' days')::interval
        AND country_code IS NOT NULL
        GROUP BY country_code
        ORDER BY count DESC
        LIMIT 10
      ) c
    ),
    'top_cities', (
      SELECT COALESCE(jsonb_agg(row_to_json(c)), '[]')
      FROM (
        SELECT city, country_code,
          COUNT(DISTINCT COALESCE(visitor_fingerprint, session_id)) as count
        FROM profile_views
        WHERE profile_id = p_profile_id
        AND created_at > now() - (p_days || ' days')::interval
        AND city IS NOT NULL
        GROUP BY city, country_code
        ORDER BY count DESC
        LIMIT 10
      ) c
    ),
    'top_sources', (
      SELECT COALESCE(jsonb_agg(row_to_json(s)), '[]')
      FROM (
        SELECT
          COALESCE(utm_source,
            CASE
              WHEN referrer ILIKE '%instagram%' THEN 'instagram'
              WHEN referrer ILIKE '%facebook%' THEN 'facebook'
              WHEN referrer ILIKE '%twitter%' OR referrer ILIKE '%t.co%' THEN 'twitter'
              WHEN referrer ILIKE '%linkedin%' THEN 'linkedin'
              WHEN referrer ILIKE '%tiktok%' THEN 'tiktok'
              WHEN referrer ILIKE '%youtube%' THEN 'youtube'
              WHEN referrer IS NOT NULL THEN 'referral'
              ELSE 'direct'
            END
          ) as source,
          COUNT(DISTINCT COALESCE(visitor_fingerprint, session_id)) as count
        FROM profile_views
        WHERE profile_id = p_profile_id
        AND created_at > now() - (p_days || ' days')::interval
        GROUP BY source
        ORDER BY count DESC
        LIMIT 10
      ) s
    ),
    'chat_opens', (
      SELECT COUNT(*) FROM jitsu_events
      WHERE profile_id = p_profile_id
      AND event_type = 'chat_opened'
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'service_clicks', (
      SELECT COUNT(*) FROM jitsu_events
      WHERE profile_id = p_profile_id
      AND event_type = 'service_click'
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'booking_modal_opens', (
      SELECT COUNT(*) FROM jitsu_events
      WHERE profile_id = p_profile_id
      AND event_type = 'booking_modal_open'
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'external_link_clicks', (
      SELECT COUNT(*) FROM jitsu_events
      WHERE profile_id = p_profile_id
      AND event_type IN ('external_link_clicked', 'download_clicked')
      AND (event_properties ->> 'destination') IS DISTINCT FROM 'page'
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'payment_gate_clicks', (
      SELECT COUNT(*) FROM jitsu_events
      WHERE profile_id = p_profile_id
      AND event_type = 'payment_gate_clicked'
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'payment_gate_unlocks', (
      SELECT COUNT(*) FROM jitsu_events
      WHERE profile_id = p_profile_id
      AND event_type = 'payment_gate_unlocked'
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'booking_requests_sent', (
      SELECT COUNT(*) FROM jitsu_events
      WHERE profile_id = p_profile_id
      AND event_type = 'booking_request_sent'
      AND created_at > now() - (p_days || ' days')::interval
    ),
    'private_links', (
      SELECT COALESCE(jsonb_agg(row_to_json(l)), '[]')
      FROM (
        SELECT
          pbl.id, pbl.title, pbl.link_slug, pbl.page_type, pbl.is_active,
          COUNT(pv.id) as views,
          COUNT(DISTINCT COALESCE(pv.visitor_fingerprint, pv.session_id)) as unique_visitors,
          (
            SELECT COUNT(*) FROM jitsu_events je
            WHERE je.profile_id = p_profile_id
            AND je.event_type = 'download_clicked'
            AND je.visited_via = pbl.link_slug
            AND je.created_at > now() - (p_days || ' days')::interval
          ) as download_clicks,
          (
            SELECT COUNT(*) FROM link_leads ll
            WHERE ll.link_id = pbl.id
            AND ll.collected_at > now() - (p_days || ' days')::interval
          ) as leads
        FROM private_booking_links pbl
        LEFT JOIN profile_views pv
          ON pv.link_id = pbl.id
          AND pv.created_at > now() - (p_days || ' days')::interval
        WHERE pbl.profile_id = p_profile_id
        GROUP BY pbl.id, pbl.title, pbl.link_slug, pbl.page_type, pbl.is_active
        ORDER BY views DESC
      ) l
    ),
    'boost_campaigns', (
      SELECT COALESCE(jsonb_agg(row_to_json(bc)), '[]')
      FROM (
        SELECT
          b.id, b.status, b.promote_type, b.budget_amount, b.budget_currency,
          b.starts_at, b.ends_at, b.utm_campaign,
          COUNT(DISTINCT COALESCE(pv.visitor_fingerprint, pv.session_id)) as driven_unique,
          COUNT(pv.id) as driven_views,
          (SELECT COUNT(*) FROM jitsu_events je WHERE je.boost_campaign_id = b.id AND je.event_type = 'booking_modal_open') as modal_opens,
          (SELECT COUNT(*) FROM jitsu_events je WHERE je.boost_campaign_id = b.id AND je.event_type = 'chat_opened') as chat_opens,
          (SELECT COUNT(*) FROM jitsu_events je WHERE je.boost_campaign_id = b.id AND je.event_type = 'service_click') as service_clicks
        FROM boost_campaigns b
        LEFT JOIN profile_views pv ON pv.boost_campaign_id = b.id
        WHERE b.profile_id = p_profile_id
        GROUP BY b.id, b.status, b.promote_type, b.budget_amount, b.budget_currency, b.starts_at, b.ends_at, b.utm_campaign
        ORDER BY b.starts_at DESC NULLS LAST
      ) bc
    ),
    'leads', (
      SELECT COALESCE(jsonb_agg(row_to_json(l) ORDER BY l.collected_at DESC), '[]')
      FROM (
        SELECT ll.id, ll.collected_at, ll.email,
          pbl.title as link_title, pbl.link_slug
        FROM link_leads ll
        LEFT JOIN private_booking_links pbl ON pbl.id = ll.link_id
        WHERE ll.profile_id = p_profile_id
        AND ll.collected_at > now() - (p_days || ' days')::interval
        ORDER BY ll.collected_at DESC
        LIMIT 50
      ) l
    ),
    'leads_total', (
      SELECT COUNT(*) FROM link_leads
      WHERE profile_id = p_profile_id
      AND collected_at > now() - (p_days || ' days')::interval
    )
  );
$function$;
