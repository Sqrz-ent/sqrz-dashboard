-- Extend profile_analytics with the link-model event types added this session:
-- external_link_clicked (consolidated with legacy download_clicked), plus
-- payment_gate_clicked / payment_gate_unlocked. New columns are appended so
-- CREATE OR REPLACE VIEW keeps the existing column order/names intact.
--
-- external_link_clicks mirrors the dashboard consumer (_app.links.tsx): count
-- both external_link_clicked + download_clicked, but exclude hero-pill clicks
-- that route to the hosted /{slug} page (event_properties.destination = 'page')
-- so the metric stays "left to an external URL". Legacy download_clicked rows
-- carry no destination and are always counted.
CREATE OR REPLACE VIEW public.profile_analytics AS
 SELECT p.id AS profile_id,
    p.slug,
    count(DISTINCT pv.id)::integer AS total_views,
    count(DISTINCT pv.visitor_fingerprint)::integer AS total_unique_visitors,
    count(DISTINCT pv.id) FILTER (WHERE pv.created_at >= (now() - '7 days'::interval) AND pv.link_id IS NULL)::integer AS views_7d,
    count(DISTINCT pv.visitor_fingerprint) FILTER (WHERE pv.created_at >= (now() - '7 days'::interval) AND pv.link_id IS NULL)::integer AS unique_visitors_7d,
    count(DISTINCT pv.id) FILTER (WHERE pv.created_at >= (now() - '14 days'::interval) AND pv.created_at < (now() - '7 days'::interval) AND pv.link_id IS NULL)::integer AS views_prev_7d,
    count(DISTINCT pv.id) FILTER (WHERE pv.utm_source IS NOT NULL)::integer AS campaign_views,
    count(DISTINCT pv.id) FILTER (WHERE pv.referrer IS NOT NULL AND pv.utm_source IS NULL)::integer AS organic_views,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'booking_modal_open'::text)::integer AS total_booking_modal_opens,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'booking_modal_open'::text AND je.created_at >= (now() - '7 days'::interval))::integer AS booking_modal_opens_7d,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'booking_request_sent'::text)::integer AS total_booking_requests,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'booking_request_sent'::text AND je.created_at >= (now() - '7 days'::interval))::integer AS booking_requests_7d,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'chat_opened'::text)::integer AS total_chat_opens,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'chat_opened'::text AND je.created_at >= (now() - '7 days'::interval))::integer AS chat_opens_7d,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'service_click'::text)::integer AS total_service_clicks,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'service_click'::text AND je.created_at >= (now() - '7 days'::interval))::integer AS service_clicks_7d,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = ANY (ARRAY['external_link_clicked'::text, 'download_clicked'::text]) AND (je.event_properties ->> 'destination'::text) IS DISTINCT FROM 'page'::text)::integer AS total_external_link_clicks,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = ANY (ARRAY['external_link_clicked'::text, 'download_clicked'::text]) AND (je.event_properties ->> 'destination'::text) IS DISTINCT FROM 'page'::text AND je.created_at >= (now() - '7 days'::interval))::integer AS external_link_clicks_7d,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'payment_gate_clicked'::text)::integer AS total_payment_gate_clicks,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'payment_gate_clicked'::text AND je.created_at >= (now() - '7 days'::interval))::integer AS payment_gate_clicks_7d,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'payment_gate_unlocked'::text)::integer AS total_payment_gate_unlocks,
    count(DISTINCT je.id) FILTER (WHERE je.event_type = 'payment_gate_unlocked'::text AND je.created_at >= (now() - '7 days'::interval))::integer AS payment_gate_unlocks_7d
   FROM profiles p
     LEFT JOIN profile_views pv ON pv.profile_id = p.id
     LEFT JOIN jitsu_events je ON je.profile_id = p.id
  GROUP BY p.id, p.slug;
