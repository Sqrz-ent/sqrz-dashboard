-- get_analytics_page: add profile-level content & click KPIs (iOS Analytics
-- "Content & Clicks" section). Previously these only existed per Boost campaign.
-- All from jitsu_events (cookieless pings from the profile pages), same
-- p_days window as the rest of the payload. Additive: existing keys unchanged.
--   widget_stats: per embed type (spotify/soundcloud/youtube) —
--     seen      = widget_visible (embed scrolled ≥50% into view, once per load)
--     plays     = widget_play
--     played_75 = widget_progress at the 75% milestone (fires once per player)
--     Spotify's embed has no player API, so it only ever reports `seen`.
--   top_ctas: most-clicked buttons by label (falls back to the link's host).
--   attention: median time on page + average scroll depth from page_exit.
do $$
declare
  def text := pg_get_functiondef('public.get_analytics_page(uuid,integer)'::regprocedure);
  new_keys text := $k$'widget_stats', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'widget_type', w.widget_type, 'seen', w.seen, 'plays', w.plays, 'played_75', w.played_75)
             order by w.seen desc, w.plays desc), '[]')
      from (
        select event_properties->>'widget_type' as widget_type,
               count(*) filter (where event_type = 'widget_visible') as seen,
               count(*) filter (where event_type = 'widget_play') as plays,
               count(*) filter (where event_type = 'widget_progress'
                                  and event_properties->>'milestone_pct' = '75') as played_75
        from public.jitsu_events
        where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
          and event_type in ('widget_visible', 'widget_play', 'widget_progress')
          and event_properties->>'widget_type' is not null
        group by 1
      ) w
    ),
    'top_ctas', (
      select coalesce(jsonb_agg(jsonb_build_object('label', c.label, 'count', c.count)
             order by c.count desc, c.label), '[]')
      from (
        select coalesce(
                 nullif(btrim(event_properties->>'link_label'), ''),
                 nullif(regexp_replace(coalesce(event_properties->>'link_url', ''), '^https?://(www\.)?([^/]+).*$', '\2'), ''),
                 'Button') as label,
               count(*) as count
        from public.jitsu_events
        where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
          and event_type = 'cta_click'
        group by 1
        order by 2 desc, 1
        limit 8
      ) c
    ),
    'attention', (
      select jsonb_build_object(
               'visits', count(*),
               'median_seconds', percentile_cont(0.5) within group (order by (event_properties->>'time_on_page_seconds')::numeric),
               'avg_scroll_pct', round(avg((event_properties->>'max_scroll_depth_pct')::numeric)))
      from public.jitsu_events
      where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
        and event_type = 'page_exit'
        and event_properties->>'time_on_page_seconds' ~ '^[0-9]+(\.[0-9]+)?$'
        and coalesce(event_properties->>'max_scroll_depth_pct', '0') ~ '^[0-9]+(\.[0-9]+)?$'
    ),
    'top_sources', ($k$;
begin
  if def !~ 'widget_stats' then
    execute replace(def, '''top_sources'', (', new_keys);
  end if;
end $$;
