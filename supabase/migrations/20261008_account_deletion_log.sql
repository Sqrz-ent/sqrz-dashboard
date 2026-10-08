-- Account deletion audit log — written by the new delete-account edge function
-- so failed best-effort external cleanup steps (Stripe/Stream/HubSpot/Meta/
-- Apple-revoke) are discoverable and retriable rather than silently lost.
-- service_role only: RLS enabled, zero policies (no role other than
-- service_role — which bypasses RLS entirely — can read or write this table).

create table public.account_deletion_log (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  step text not null,
  status text not null check (status in ('ok', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

alter table public.account_deletion_log enable row level security;

comment on table public.account_deletion_log is
  'Audit trail for the delete-account edge function. service_role only (RLS on, no policies).';
