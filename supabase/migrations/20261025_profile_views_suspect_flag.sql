-- Bot/datacenter traffic filtering for profile_views (GCMN incident, 2026-10).
-- Non-destructive: suspect rows are flagged, never deleted. Every analytics
-- read path reads profile_views_counted (= profile_views minus suspect rows).

alter table public.profile_views
  add column if not exists is_suspect boolean not null default false;

create or replace view public.profile_views_counted
  with (security_invoker = true) as
  select * from public.profile_views where not is_suspect;

revoke all on public.profile_views_counted from anon, authenticated;

-- Flagging rules. Re-runnable (idempotent) for any time window, e.g. after a
-- new datacenter town shows up: select flag_suspect_profile_views(now() - interval '30 days');
-- The city list mirrors lib/tracking/botFilter.ts in sqrz (the profile pages
-- repo) — keep the two in sync.
create or replace function public.flag_suspect_profile_views(p_since timestamptz default '-infinity')
returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_count integer;
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
  return v_count;
end;
$function$;

revoke all on function public.flag_suspect_profile_views(timestamptz) from public, anon, authenticated;

-- Point every analytics read function at the filtered view. All 21
-- references are plain FROM/JOIN table references (checked before applying).
do $$
declare
  f regprocedure;
  def text;
begin
  foreach f in array array[
    'public.get_analytics_page(uuid,integer)',
    'public.get_profile_analytics(uuid,integer)',
    'public.get_campaign_metrics(uuid)',
    'public.get_link_metrics(uuid)',
    'public.get_boost_campaign_native_stats(uuid)'
  ]::regprocedure[] loop
    def := regexp_replace(pg_get_functiondef(f),
      '\m(from|join)(\s+)(public\.)?profile_views\M',
      '\1\2public.profile_views_counted', 'gi');
    execute def;
  end loop;

  execute 'create or replace view public.profile_analytics as ' ||
    regexp_replace(pg_get_viewdef('public.profile_analytics'::regclass),
      '\m(from|join)(\s+)(public\.)?profile_views\M',
      '\1\2public.profile_views_counted', 'gi');
end $$;

select public.flag_suspect_profile_views();
