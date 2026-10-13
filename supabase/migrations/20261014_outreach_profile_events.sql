-- Labeled engagement events on an outreach-tracked profile visit (VenueFindr
-- outreach link, ?r=[token]) — e.g. which CTA/service/download the visitor
-- actually tapped, distinct from the scroll/play/link-tap counters already
-- captured on outreach_profile_sessions (see 20261013_outreach_tracking.sql).
-- Embeds (SoundCloud/YouTube/Spotify progress) are out of scope.
--
-- Same RLS shape as the rest of this feature: enabled, zero policies — every
-- access goes through record_outreach_event / get_outreach_events below.

create table public.outreach_profile_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.outreach_profile_sessions(id) on delete cascade,
  event_type text not null check (event_type in ('cta_tap', 'service_tap', 'contact_open', 'contact_submit', 'download')),
  label text check (char_length(label) <= 100),
  created_at timestamptz not null default now()
);

create index outreach_profile_events_session_id_idx on public.outreach_profile_events(session_id);

alter table public.outreach_profile_events enable row level security;

comment on table public.outreach_profile_events is
  'Labeled engagement events (cta_tap/service_tap/contact_open/contact_submit/download) for an outreach-tracked profile session. RLS on, no policies — written only via record_outreach_event, read only via get_outreach_events.';

-- ── record_outreach_event ───────────────────────────────────────────────────
-- Called from sqrz-profiles' client-side outreach relay (anon key) at each
-- labeled hook point (CTA tap, service tap, contact form open/submit,
-- download). Mirrors record_profile_engagement's validation: only writes
-- when the token exists AND its slug matches p_slug AND the given session
-- actually belongs to that token's link — otherwise a silent no-op (defends
-- against a token/session minted for one profile being replayed against
-- another, same as record_profile_engagement). Unknown event types are a
-- hard reject (a client bug, not a security probe) — matches
-- create_outreach_link's "raise on bad input" precedent rather than
-- record_profile_engagement's "silent no-op on mismatch" one. Label is
-- clamped to 100 chars (defense in depth — callers already cap client-side)
-- rather than rejected, matching record_profile_engagement's scroll_pct clamp.
create or replace function public.record_outreach_event(
  p_token text,
  p_session_id uuid,
  p_slug text,
  p_event_type text,
  p_label text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link_id uuid;
  v_session_link_id uuid;
begin
  if p_event_type not in ('cta_tap', 'service_tap', 'contact_open', 'contact_submit', 'download') then
    raise exception 'Unknown event type: %', p_event_type;
  end if;

  select id into v_link_id
  from outreach_links
  where token = p_token and slug = p_slug;

  if v_link_id is null then
    return;
  end if;

  select link_id into v_session_link_id
  from outreach_profile_sessions
  where id = p_session_id;

  if v_session_link_id is null or v_session_link_id <> v_link_id then
    return;
  end if;

  insert into outreach_profile_events (session_id, event_type, label)
  values (p_session_id, p_event_type, left(p_label, 100));
end;
$$;

-- ── get_outreach_events ──────────────────────────────────────────────────────
-- Called by VenueFindr (anon key). One row per (token, event_type, label)
-- combination actually seen, scoped to p_device_id same as
-- get_outreach_clicks/get_outreach_engagement — a device can only ever see
-- events on tokens it itself created.
create or replace function public.get_outreach_events(
  p_device_id text,
  p_tokens text[]
)
returns table(
  token text,
  event_type text,
  label text,
  count bigint,
  last_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    l.token,
    e.event_type,
    e.label,
    count(*) as count,
    max(e.created_at) as last_at
  from outreach_links l
  join outreach_profile_sessions s on s.link_id = l.id
  join outreach_profile_events e on e.session_id = s.id
  where l.device_id = p_device_id
    and l.token = any(p_tokens)
  group by l.token, e.event_type, e.label;
$$;
