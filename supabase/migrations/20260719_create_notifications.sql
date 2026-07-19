-- In-app notifications feed. Rows are inserted by DB triggers (campaign status,
-- booking status, new inquiry) and by the campaign-advisor edge function
-- (advisor_warning). push_worthy is unused this phase — it marks rows a future
-- push-sending phase may deliver as pushes; nothing sends pushes yet.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  type text not null check (type in
    ('campaign_status','campaign_ended','booking','advisor_warning','chat_request')),
  subtype text,                                -- status value, severity level, etc.
  related_id uuid,                             -- campaign_id / booking_id / advisor run id
  deep_link text,                              -- route to open on tap
  push_worthy boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_profile_created_idx
  on public.notifications (profile_id, created_at desc);

-- RLS: owners read + mark-read their own rows. No INSERT policy — inserts come
-- only from SECURITY DEFINER triggers and the service-role edge function.
alter table public.notifications enable row level security;

create policy "notifications_select_own" on public.notifications
  for select using (profile_id in (select get_profile_id_for_user(auth.uid())));

create policy "notifications_update_own" on public.notifications
  for update using (profile_id in (select get_profile_id_for_user(auth.uid())));

-- ── Trigger: boost_campaigns status change ──────────────────────────────────
-- Terminal transitions (completed/cancelled/rejected) produce campaign_ended;
-- every other status change produces campaign_status (one row per transition,
-- never both). push_worthy=false for both this phase.
create or replace function public.notify_campaign_status_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and new.status is not null
     and new.profile_id is not null then
    insert into notifications (profile_id, type, subtype, related_id, deep_link, push_worthy)
    values (
      new.profile_id,
      case when new.status in ('completed','cancelled','rejected')
           then 'campaign_ended' else 'campaign_status' end,
      new.status,
      new.id,
      '/analytics?campaign=' || new.id::text,
      false
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_campaign_status_notify on public.boost_campaigns;
create trigger on_campaign_status_notify
  after update of status on public.boost_campaigns
  for each row execute function public.notify_campaign_status_change();

-- ── Trigger: booking status change ──────────────────────────────────────────
-- New request (INSERT) + transitions to confirmed/cancelled. push_worthy=true.
create or replace function public.notify_booking_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.owner_id is not null then
      insert into notifications (profile_id, type, subtype, related_id, deep_link, push_worthy)
      values (new.owner_id, 'booking', coalesce(new.status, 'requested'),
              new.id, '/booking/' || new.id::text, true);
    end if;
  elsif new.status is distinct from old.status
        and new.status in ('confirmed','cancelled')
        and new.owner_id is not null then
    insert into notifications (profile_id, type, subtype, related_id, deep_link, push_worthy)
    values (new.owner_id, 'booking', new.status,
            new.id, '/booking/' || new.id::text, true);
  end if;
  return new;
end;
$$;

drop trigger if exists on_booking_change_notify on public.bookings;
create trigger on_booking_change_notify
  after insert or update of status on public.bookings
  for each row execute function public.notify_booking_change();

-- ── Trigger: new inbound chat/proposal inquiry ──────────────────────────────
-- The only creation point for inquiry threads is startInquirySession in
-- sqrz-profiles (POST /api/inquiries/start) inserting into
-- profile_inquiry_threads; the dashboard only reads/updates threads. A trigger
-- on that INSERT hooks the actual event regardless of which repo inserts.
-- deep_link points at the dashboard root for now — the web inquiry view is the
-- shell-mounted bubble with no dedicated route (and no iOS UI exists yet).
create or replace function public.notify_new_inquiry()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.profile_id is not null then
    insert into notifications (profile_id, type, subtype, related_id, deep_link, push_worthy)
    values (new.profile_id, 'chat_request', new.status, new.id, '/', true);
  end if;
  return new;
end;
$$;

drop trigger if exists on_inquiry_created_notify on public.profile_inquiry_threads;
create trigger on_inquiry_created_notify
  after insert on public.profile_inquiry_threads
  for each row execute function public.notify_new_inquiry();
