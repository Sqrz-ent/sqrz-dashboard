-- Placeholder capture destination for the marketing site's slug-checker
-- "available" popup (sqrz-cast UsernameChecker.svelte, 2026-08-14). Beta
-- gatekeeping: self-serve dashboard signup is no longer reachable from the
-- marketing page at all — an available slug now opens this form instead of
-- redirecting to dashboard.sqrz.com/join. Full field set is TBD (Will to
-- define); `extra` is a jsonb catch-all so new fields can be added to the
-- form before the schema is finalized without a migration each time.
-- Applied via apply_migration on 2026-08-14.
create table public.beta_interest_submissions (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  ad_budget text,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.beta_interest_submissions enable row level security;

-- Public (anon) insert only — same shape as cookie_consents_anon_insert.
-- No SELECT policy: reads are service-role only (admin/internal review),
-- matching the pattern used for other unauthenticated-visitor capture tables.
create policy beta_interest_submissions_anon_insert
  on public.beta_interest_submissions
  for insert
  to public
  with check (true);

comment on table public.beta_interest_submissions is
  'Placeholder capture for the marketing-site slug-checker "available" popup (sqrz-cast). Anon-insert-only, no public read. Field set is a work in progress — extra jsonb holds anything not yet promoted to a real column.';
comment on column public.beta_interest_submissions.slug is 'The slug the visitor checked and was told is available (not yet claimed/created as a real profile).';
comment on column public.beta_interest_submissions.ad_budget is 'Free-text advertising-budget response — bucket/format not yet standardized.';
comment on column public.beta_interest_submissions.extra is 'Catch-all for additional form fields added before the full field set is finalized.';
