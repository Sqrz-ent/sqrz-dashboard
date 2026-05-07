create table if not exists public.profile_inquiry_threads (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'converted', 'closed')),
  provider text not null default 'stream' check (provider in ('stream')),
  provider_channel_id text not null unique,
  visitor_token uuid not null unique default gen_random_uuid(),
  visitor_stream_user_id text not null unique,
  owner_stream_user_id text not null,
  visitor_name text null,
  visitor_email text null,
  converted_booking_id uuid null references public.bookings(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profile_inquiry_threads_profile_status_idx
  on public.profile_inquiry_threads (profile_id, status, created_at desc);

create index if not exists profile_inquiry_threads_status_idx
  on public.profile_inquiry_threads (status, created_at desc);
