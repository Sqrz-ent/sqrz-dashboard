-- Expose boost_campaigns.channels through the stats view the Boost page reads.
-- Appended after status_updated_at; bc.id is the PK so it's group-by safe.
CREATE OR REPLACE VIEW public.boost_campaign_stats AS
 SELECT bc.id,
    bc.created_at,
    bc.profile_id,
    bc.promote_type,
    bc.promote_link_id,
    bc.promote_service_id::text AS promote_service_id,
    bc.goal,
    bc.budget_amount,
    bc.budget_currency,
    bc.notes,
    bc.status,
    bc.channel,
    bc.duration,
    bc.utm_url,
    bc.utm_source,
    bc.utm_medium,
    bc.utm_campaign,
    bc.utm_content,
    bc.starts_at,
    bc.ends_at,
    bc.target_audience,
    bc.campaign_type,
    bc.fee_pct,
    bc.fee_amount,
    bc.stripe_payment_id,
    bc.stripe_payment_status,
    NULL::text AS stripe_payment_link_id,
    bc.stripe_payment_link_url,
    bc.requires_payment,
    bc.payment_expires_at,
    count(pv.id)::integer AS live_profile_visits,
    count(DISTINCT pv.visitor_fingerprint)::integer AS live_unique_visitors,
    count(
        CASE
            WHEN pv.created_at >= (now() - '7 days'::interval) THEN 1
            ELSE NULL::integer
        END)::integer AS live_visits_last_7_days,
    NULL::integer AS live_engaged,
    NULL::integer AS live_service_clicks,
    NULL::integer AS live_booking_modal_opens,
    NULL::integer AS live_chat_opens,
    NULL::integer AS live_download_clicks,
        CASE
            WHEN bc.starts_at IS NOT NULL THEN GREATEST(0, CURRENT_DATE - bc.starts_at)
            ELSE NULL::integer
        END AS campaign_days_elapsed,
        CASE
            WHEN bc.starts_at IS NOT NULL AND bc.ends_at IS NOT NULL THEN bc.ends_at - bc.starts_at
            ELSE NULL::integer
        END AS campaign_duration_days,
        CASE
            WHEN bc.ends_at IS NOT NULL THEN GREATEST(0, bc.ends_at - CURRENT_DATE)
            ELSE NULL::integer
        END AS campaign_days_remaining,
        CASE
            WHEN count(pv.id) > 0 THEN 'live'::text
            ELSE 'manual'::text
        END AS data_source,
    bc.review_feedback,
    bc.creative_asset_url,
    bc.status_updated_at,
    bc.channels
   FROM boost_campaigns bc
     LEFT JOIN profile_views pv ON pv.boost_campaign_id = bc.id
  GROUP BY bc.id;
