-- Adds a third rule to flag_suspect_profile_views: strictly periodic hits.
-- Found on GCMN (2026-10-22 →): an uptime-style monitor fetching the profile
-- every 60.0 min (stddev < 2 min) from 10 cloud regions, ~240 fake views/day,
-- rotating IPs (so many fingerprints), never a referrer. The >=3 fingerprint
-- floor keeps real repeat visitors (one or two devices coming back) unflagged.
create or replace function public.flag_suspect_profile_views(p_since timestamptz default '-infinity')
returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_count integer;
  v_periodic integer;
begin
  with bursts as (
    -- Meta's preview/ad-review crawls: many server-rendered hits on one
    -- profile from one city within the same minute, each a different
    -- fingerprint, none with a referrer. Real visitor bursts (story shares,
    -- one person refreshing) carry referrers or repeat a fingerprint.
    select profile_id, city, date_trunc('minute', created_at) as m
    from profile_views
    where created_at >= p_since and link_id is null and city is not null
    group by 1, 2, 3
    having count(*) >= 5
       and count(distinct visitor_fingerprint) >= 5
       and count(referrer) = 0
  )
  update profile_views pv
  set is_suspect = true
  where pv.created_at >= p_since
    and not pv.is_suspect
    and (
      lower(pv.city) = any (array[
        'santa clara','ashburn','boardman','hillsboro','ogden','los lunas',
        'manassas','dekalb','north charleston','chicago','council bluffs',
        'the dalles','gallatin','social circle','huntsville','north bergen',
        'burlington','monte vista','prineville','altoona','fort worth',
        'forest city','papillion','eagle mountain','new albany','sandston',
        'henrico','clonee','odense','lulea','luleå','singapore','seoul','pune',
        'são paulo','sao paulo','falkenstein'])
      or pv.country_code in ('T1', 'CN')
      or exists (
        select 1 from bursts b
        where b.profile_id = pv.profile_id
          and b.city = pv.city
          and b.m = date_trunc('minute', pv.created_at)
          and pv.link_id is null
      )
    );
  get diagnostics v_count = row_count;

  -- Periodic monitors: per profile + city + day, >=6 referrer-less hits from
  -- >=3 fingerprints whose spacing is near-constant (stddev < 5 min, ignoring
  -- overnight gaps > 3h) and at least 5 min apart on average.
  with g as (
    select id, profile_id, city, visitor_fingerprint, created_at::date as d,
      extract(epoch from created_at - lag(created_at)
        over (partition by profile_id, city order by created_at)) / 60 as gap
    from profile_views
    where created_at >= p_since and referrer is null and link_id is null
      and city is not null and not is_suspect
  ), periodic as (
    select profile_id, city, d from g
    group by 1, 2, 3
    having count(*) >= 6
       and count(distinct visitor_fingerprint) >= 3
       and stddev(gap) filter (where gap <= 180) < 5
       and avg(gap) filter (where gap <= 180) >= 5
  )
  update profile_views pv
  set is_suspect = true
  from g join periodic using (profile_id, city, d)
  where pv.id = g.id;
  get diagnostics v_periodic = row_count;

  return v_count + v_periodic;
end;
$function$;

revoke all on function public.flag_suspect_profile_views(timestamptz) from public, anon, authenticated;

select public.flag_suspect_profile_views();
