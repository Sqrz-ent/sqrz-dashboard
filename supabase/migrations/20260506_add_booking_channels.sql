create table if not exists public.booking_channels (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  provider text not null check (provider in ('supabase', 'stream')),
  provider_channel_id text not null,
  type text not null check (type in ('main', 'role')),
  role_key text null,
  created_at timestamptz not null default now()
);

create unique index if not exists booking_channels_provider_channel_uidx
  on public.booking_channels (provider, provider_channel_id);

create unique index if not exists booking_channels_booking_scope_uidx
  on public.booking_channels (
    booking_id,
    provider,
    type,
    coalesce(role_key, '')
  );

create index if not exists booking_channels_booking_id_idx
  on public.booking_channels (booking_id);
