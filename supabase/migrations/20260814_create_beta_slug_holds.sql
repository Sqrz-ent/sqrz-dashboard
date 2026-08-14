-- Backs the marketing site's beta-request popup (sqrz-cast
-- UsernameChecker.svelte, 2026-08-14 — supersedes the earlier
-- beta_interest_submissions destination, which is left in place but now
-- unreferenced by any client). A "hold" reserves a slug for a beta requester
-- without creating a real profiles row.
--
-- Found already live (0 rows, unique(slug) constraint already in place) with
-- no migration on record — the same undocumented-drift pattern flagged
-- elsewhere in this repo's CLAUDE.md. `if not exists` catches up the history;
-- the constraint shape (plain unique(slug), not scoped to unclaimed-only) is
-- exactly what was already live and is not changed here. RLS was found
-- DISABLED (public anon key could read/write directly via PostgREST) —
-- locked down in this same migration since it wasn't yet applied live.
create table if not exists public.beta_slug_holds (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  hubspot_contact_id text,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.beta_slug_holds enable row level security;
-- No policies: service-role only. All writes go through the
-- hubspot-beta-slug-request edge function (service role), after a successful
-- HubSpot contact sync — no public insert or read path directly on this table.

comment on table public.beta_slug_holds is
  'Slug reservations from the marketing-site beta-request popup (sqrz-cast). Written only by the hubspot-beta-slug-request edge function, after a successful HubSpot contact sync. RLS on, no policies = service-role only. claimed_at null = still held/unclaimed.';
comment on column public.beta_slug_holds.hubspot_contact_id is 'The HubSpot contact id returned by the create/update call this hold was written alongside.';
comment on column public.beta_slug_holds.claimed_at is 'Set when this hold converts to a real signup (not yet built — no claim flow exists yet). Null = still an open hold.';
