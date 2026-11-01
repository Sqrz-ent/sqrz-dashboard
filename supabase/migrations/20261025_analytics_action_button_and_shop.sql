-- get_analytics_page: Action Button + Shop KPIs (iOS Analytics, Content & Clicks).
-- Event sources (sqrz profile pages, 2026-10-25):
--   cta_click with event_properties.cta_source ∈ scheduling/shop/external/
--     private_link (+ provider: calendly/hubspot/linkout/…) — every Action
--     Button / floating-CTA tap on the profile page and private-link pages.
--   shop_visible {provider} — shop section scrolled ≥30% into view, once per load.
--   shop_click {provider, product_title} — a product card's "Buy Now".
--     (BeatStars sells inside its own iframe, so it only ever has shop_visible.)
-- Additive keys; existing payload unchanged. Only events recorded since the
-- profile-page deploy carry these fields — older clicks were never captured.
do $$
declare
  def text := pg_get_functiondef('public.get_analytics_page(uuid,integer)'::regprocedure);
  new_keys text := $k$'action_button_clicks', (
      select coalesce(jsonb_agg(jsonb_build_object('source', a.source, 'provider', a.provider, 'count', a.count)
             order by a.count desc, a.source), '[]')
      from (
        select event_properties->>'cta_source' as source,
               nullif(event_properties->>'provider', '') as provider,
               count(*) as count
        from public.jitsu_events
        where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
          and event_type = 'cta_click'
          and event_properties->>'cta_source' is not null
        group by 1, 2
      ) a
    ),
    'shop_stats', (
      select coalesce(jsonb_agg(jsonb_build_object('provider', s.provider, 'seen', s.seen, 'clicks', s.clicks)
             order by s.seen desc, s.provider), '[]')
      from (
        select coalesce(event_properties->>'provider', 'shop') as provider,
               count(*) filter (where event_type = 'shop_visible') as seen,
               count(*) filter (where event_type = 'shop_click') as clicks
        from public.jitsu_events
        where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
          and event_type in ('shop_visible', 'shop_click')
        group by 1
      ) s
    ),
    'top_sources', ($k$;
begin
  if def !~ 'action_button_clicks' then
    execute replace(def, '''top_sources'', (', new_keys);
  end if;
end $$;
