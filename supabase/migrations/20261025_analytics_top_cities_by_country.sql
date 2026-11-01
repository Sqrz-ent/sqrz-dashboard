-- get_analytics_page: add 'top_cities_by_country' so clients can filter the
-- city list by a selected country. 'top_cities' stays the global top 10, so
-- filtering it client-side would hide a country's cities that didn't make the
-- global cut. This returns up to 12 cities for every country, same metric
-- (unique visitors) and same bot-filtered source (profile_views_counted).
-- Additive: existing keys and callers are unchanged.
do $$
declare
  def text := pg_get_functiondef('public.get_analytics_page(uuid,integer)'::regprocedure);
  new_key text := $k$'top_cities_by_country', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'country_code', r.country_code, 'city', r.city, 'count', r.count)
             order by r.country_code, r.count desc, r.city), '[]')
      from (
        select country_code, city, count,
               row_number() over (partition by country_code order by count desc, city) as rn
        from (
          select country_code, city, count(distinct coalesce(visitor_fingerprint, session_id)) as count
          from public.profile_views_counted
          where profile_id = p_profile_id and created_at > now() - (p_days || ' days')::interval
          and city is not null and country_code is not null
          group by country_code, city
        ) g
      ) r
      where r.rn <= 12
    ),
    'top_sources', ($k$;
begin
  if def !~ 'top_cities_by_country' then
    execute replace(def, '''top_sources'', (', new_key);
  end if;
end $$;
