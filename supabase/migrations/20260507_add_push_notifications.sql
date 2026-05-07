create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  platform text null,
  user_agent text null,
  app_scope text null,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists push_subscriptions_endpoint_uidx
  on public.push_subscriptions (endpoint);

create index if not exists push_subscriptions_profile_id_idx
  on public.push_subscriptions (profile_id);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

create index if not exists push_subscriptions_active_idx
  on public.push_subscriptions (is_active, last_seen_at desc);

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  actor_profile_id uuid null references public.profiles(id) on delete set null,
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('inquiry_message', 'booking_message')),
  source_id text not null,
  title text not null,
  body text not null,
  target_url text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'clicked', 'dismissed')),
  delivery_attempts integer not null default 0,
  last_error text null,
  sent_at timestamptz null,
  clicked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_events_recipient_status_idx
  on public.notification_events (recipient_profile_id, status, created_at desc);

create index if not exists notification_events_profile_status_idx
  on public.notification_events (profile_id, status, created_at desc);

create index if not exists notification_events_type_idx
  on public.notification_events (type, created_at desc);
