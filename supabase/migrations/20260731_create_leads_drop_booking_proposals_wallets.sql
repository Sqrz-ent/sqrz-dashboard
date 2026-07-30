-- Unify inquiry/booking capture into a single flat `leads` table (active|archived,
-- no stages), and tear down the dead staged-booking payout pipeline
-- (booking_proposals, booking_wallets, wallet_allocations). `bookings` +
-- `booking_participants` + `create_booking_request` are KEPT for the public web
-- booking form (intake only). Applied via apply_migration on 2026-07-31.

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  -- one lead per inquiry thread (chat source); null for non-chat leads. Lets the
  -- Archive / Keep Active actions upsert the same row per thread.
  thread_id uuid unique references public.profile_inquiry_threads(id) on delete set null,
  name text,
  email text,
  message text,
  source text not null check (source in ('web_form','chat')),
  campaign_id uuid references public.boost_campaigns(id) on delete set null,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index leads_profile_status_updated_idx on public.leads (profile_id, status, updated_at desc);

alter table public.leads enable row level security;

create policy leads_owner_select on public.leads for select
  using (profile_id = public.get_profile_id_for_user(auth.uid()));

grant select on public.leads to authenticated;

create trigger leads_updated_at before update on public.leads
  for each row execute function public.handle_updated_at();

-- Drop the dead payout/proposal pipeline. wallet_allocations FKs booking_wallets
-- and is fully dead (no code refs, routes already removed) — drop it first.
drop table if exists public.wallet_allocations cascade;
drop table if exists public.booking_wallets cascade;
drop table if exists public.booking_proposals cascade;
drop function if exists public.enforce_proposal_decision() cascade;
