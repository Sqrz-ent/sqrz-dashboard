-- get_analytics_page: add widget_stats[].plays_tracked.
-- Spotify plays became measurable 2026-10-26 (profile pages switched to
-- Spotify's iFrame API). Before that the plain embed couldn't report plays, so
-- a 0 for a range reaching back before the launch would be misleading.
-- plays_tracked = false → clients show "No data" instead of a number:
--   only for spotify, only while the range starts before the launch AND no
--   Spotify plays have been recorded in it. Other widget types: always true.
-- Additive key — older app builds ignore it.
do $$
declare
  def text := pg_get_functiondef('public.get_analytics_page(uuid,integer)'::regprocedure);
  old_obj text := $o$'widget_type', w.widget_type, 'seen', w.seen, 'plays', w.plays, 'played_75', w.played_75)$o$;
  new_obj text := $n$'widget_type', w.widget_type, 'seen', w.seen, 'plays', w.plays, 'played_75', w.played_75,
               'plays_tracked', (w.widget_type <> 'spotify' or w.plays > 0
                                 or now() - (p_days || ' days')::interval >= timestamptz '2026-10-26 00:00+00'))$n$;
begin
  if def !~ 'plays_tracked' then
    if position(old_obj in def) = 0 then
      raise exception 'widget_stats object not found in get_analytics_page';
    end if;
    execute replace(def, old_obj, new_obj);
  end if;
end $$;
