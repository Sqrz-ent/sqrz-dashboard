-- Fuzzy city resolution for the generate-tour-plan edge function.
--
-- The LLM (Stage 1) sometimes emits a city spelling that differs from what's
-- stored in `venues.city` — an exonym/near-spelling/casing/umlaut mismatch
-- (e.g. "Hannover" vs stored "Hanover", "ACCRA" vs "Accra"). An exact match
-- then silently returns zero venues. This resolves each suggested name to the
-- real stored spelling via pg_trgm similarity(), so those cities aren't dropped.
--
-- Applied to the live DB via MCP apply_migration on 2026-09-03; committed here
-- so the change is tracked in-repo (avoids the undocumented-drift pattern).

create extension if not exists pg_trgm with schema extensions;

-- Resolves LLM-suggested city names to the actual spelling stored in `venues`.
-- Exact case-insensitive match always wins (forced score 1.0); otherwise the
-- best fuzzy match at or above p_threshold. Inputs with no match at all return
-- no row (the caller falls back to the original spelling). Default threshold 0.6
-- catches the recurring near-spelling cases (Hannover/Hanover = 0.70,
-- ACCRA/Accra = 1.0) while staying clear of the false-positive band measured
-- against genuinely different cities (Berlin/Bern 0.33, Hanover/Hamburg 0.14).
create or replace function public.resolve_venue_cities(
  p_cities text[],
  p_threshold real default 0.6
)
returns table(input text, resolved text, sim real)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with inputs as (
    select distinct trim(c) as input
    from unnest(p_cities) as c
    where trim(c) <> ''
  ),
  distinct_cities as (
    select distinct city from venues where city is not null and city <> ''
  ),
  ranked as (
    select
      i.input,
      dc.city as resolved,
      case when lower(dc.city) = lower(i.input) then 1.0::real
           else similarity(i.input, dc.city) end as sim
    from inputs i
    join distinct_cities dc
      on lower(dc.city) = lower(i.input)
      or similarity(i.input, dc.city) >= p_threshold
  )
  select distinct on (input) input, resolved, sim
  from ranked
  order by input, sim desc, resolved
$$;

grant execute on function public.resolve_venue_cities(text[], real)
  to anon, authenticated, service_role;
