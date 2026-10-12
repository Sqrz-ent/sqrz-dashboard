-- Outreach tracking: VenueFindr generates a per-venue outreach link
-- (https://[slug].sqrz.com?r=[token]) and this project logs the click
-- (server-side, every request carrying r — see sqrz-profiles middleware)
-- and visitor engagement (client-side, session-scoped, no cookies/
-- localStorage/visitor identifiers — see sqrz-profiles' OutreachEngagementGate).
--
-- All three tables: RLS enabled, zero policies — no anon/authenticated role
-- can read or write them directly. Every access goes through one of the
-- SECURITY DEFINER RPCs below, each of which does its own ownership/validity
-- check in the function body (device_id match, token/slug match) rather than
-- relying on RLS for that. No raw IP address is stored anywhere.

create table public.outreach_links (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,
  device_id text not null,
  venue_id text references public.venues(id),
  slug text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index outreach_links_device_id_idx on public.outreach_links(device_id);

alter table public.outreach_links enable row level security;

comment on table public.outreach_links is
  'One row per VenueFindr outreach link (token in the ?r= query param). RLS on, no policies — access only via the outreach_* RPCs.';

create table public.outreach_clicks (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.outreach_links(id) on delete cascade,
  clicked_at timestamptz not null default now(),
  user_agent text,
  is_likely_bot boolean not null,
  bot_reason text
);

create index outreach_clicks_link_id_idx on public.outreach_clicks(link_id);

alter table public.outreach_clicks enable row level security;

comment on table public.outreach_clicks is
  'Server-side click log, one row per request carrying a valid ?r= token (see log_outreach_click). RLS on, no policies.';

create table public.outreach_profile_sessions (
  id uuid primary key,
  link_id uuid not null references public.outreach_links(id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz,
  max_scroll_pct int not null default 0,
  plays int not null default 0,
  link_taps int not null default 0
);

create index outreach_profile_sessions_link_id_idx on public.outreach_profile_sessions(link_id);

alter table public.outreach_profile_sessions enable row level security;

comment on table public.outreach_profile_sessions is
  'Client-side engagement per page load (id is client-generated, in-memory only — no cookies/localStorage). RLS on, no policies — written only via record_profile_engagement.';

-- ── Internal helper — NOT part of the public RPC surface ───────────────────
-- Explicitly revoked below: this project auto-grants EXECUTE directly to
-- anon/authenticated/service_role on every new function (confirmed via
-- pg_proc.proacl — explicit per-role ACL entries, not a PUBLIC grant), so
-- "revoke ... from public" is a no-op here; it has to target those roles
-- directly. The six real RPCs below are deliberately left on that default
-- grant — same as every other anon-callable RPC in this project.
create or replace function public.generate_base62_token(p_length int default 8)
returns text
language plpgsql
as $$
declare
  chars text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  result text := '';
begin
  for i in 1..p_length loop
    result := result || substr(chars, floor(random() * 62)::int + 1, 1);
  end loop;
  return result;
end;
$$;

revoke execute on function public.generate_base62_token(int) from anon, authenticated;

-- ── create_outreach_link ────────────────────────────────────────────────────
-- Called by VenueFindr (anon key) when it's about to send an outreach
-- message for a venue. Rejects (raises) if the slug doesn't exist; the venue
-- FK enforces venue_id validity the same way. Retries on a token collision
-- (vanishingly unlikely at 8 base62 chars, but cheap to guard).
create or replace function public.create_outreach_link(
  p_device_id text,
  p_venue_id text,
  p_slug text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if not exists (select 1 from profiles where slug = p_slug) then
    raise exception 'Unknown slug: %', p_slug;
  end if;

  loop
    v_token := generate_base62_token(8);
    exit when not exists (select 1 from outreach_links where token = v_token);
  end loop;

  insert into outreach_links (token, device_id, venue_id, slug)
  values (v_token, p_device_id, p_venue_id, p_slug);

  return v_token;
end;
$$;

-- ── mark_outreach_sent ───────────────────────────────────────────────────────
-- Called by VenueFindr right after it actually sends the message carrying
-- this token. Only the first call sets sent_at (guarded by `sent_at is
-- null`) — re-marking later would reset the "too_fast" bot-detection window
-- in log_outreach_click, which should anchor to the real original send time.
-- Returns whether it actually updated a row (device_id mismatch or already
-- sent → false), so the caller can tell the difference from a no-op.
create or replace function public.mark_outreach_sent(
  p_device_id text,
  p_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update outreach_links
  set sent_at = now()
  where token = p_token
    and device_id = p_device_id
    and sent_at is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ── log_outreach_click ───────────────────────────────────────────────────────
-- Called from sqrz-profiles middleware (anon key, via event.waitUntil — never
-- awaited in the response path) on every request carrying ?r=. Does the
-- whole job server-side: token/slug validation, bot classification, insert.
-- Unknown or slug-mismatched token → silent no-op (never surfaces an error to
-- the caller either way, but this also means a request for the wrong profile
-- can't be used to probe whether a token exists).
create or replace function public.log_outreach_click(
  p_token text,
  p_slug text,
  p_user_agent text,
  p_is_head boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link_id uuid;
  v_sent_at timestamptz;
  v_created_at timestamptz;
  v_reference_at timestamptz;
  v_is_bot boolean := false;
  v_reason text := null;
  v_ua text := coalesce(p_user_agent, '');
begin
  select id, sent_at, created_at
  into v_link_id, v_sent_at, v_created_at
  from outreach_links
  where token = p_token and slug = p_slug;

  if v_link_id is null then
    return;
  end if;

  if p_is_head then
    v_is_bot := true;
    v_reason := 'head_request';
  elsif v_ua = '' or v_ua ~* '(slackbot|facebookexternalhit|twitterbot|linkedinbot|discordbot|telegrambot|whatsapp|applebot|googlebot|bingbot|bingpreview|skypeuripreview|microsoft office|mimecast|proofpoint|barracuda|curl|python-requests|go-http-client|headlesschrome)' then
    v_is_bot := true;
    v_reason := 'user_agent';
  else
    v_reference_at := coalesce(v_sent_at, v_created_at);
    if v_reference_at is not null and now() - v_reference_at < interval '120 seconds' then
      v_is_bot := true;
      v_reason := 'too_fast';
    end if;
  end if;

  insert into outreach_clicks (link_id, user_agent, is_likely_bot, bot_reason)
  values (v_link_id, p_user_agent, v_is_bot, v_reason);
end;
$$;

-- ── get_outreach_clicks ──────────────────────────────────────────────────────
-- Called by VenueFindr (anon key) to show click status for its own links.
-- Scoped to p_device_id — a device can only ever see clicks on tokens it
-- itself created.
create or replace function public.get_outreach_clicks(
  p_device_id text,
  p_tokens text[]
)
returns table(token text, clicked_at timestamptz, is_likely_bot boolean)
language sql
security definer
set search_path = public
stable
as $$
  select l.token, c.clicked_at, c.is_likely_bot
  from outreach_clicks c
  join outreach_links l on l.id = c.link_id
  where l.device_id = p_device_id
    and l.token = any(p_tokens);
$$;

-- ── record_profile_engagement ────────────────────────────────────────────────
-- Called from sqrz-profiles' client-side OutreachEngagementGate (anon key) —
-- on load, every 15s while visible, and once on hide. Only writes anything
-- if the token exists AND its slug matches p_slug (defends against a token
-- minted for one profile being replayed against another). p_session_id is a
-- client-generated UUID, in-memory only for that one page load — upserting
-- on it means repeated calls from the SAME load accumulate onto one session
-- row (last_seen_at refreshed, scroll max'd, plays/taps summed), while a
-- fresh page load always starts a new session row.
create or replace function public.record_profile_engagement(
  p_token text,
  p_session_id uuid,
  p_slug text,
  p_scroll_pct int,
  p_play boolean,
  p_link_tap boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link_id uuid;
  v_scroll_pct int := greatest(0, least(100, coalesce(p_scroll_pct, 0)));
begin
  select id into v_link_id
  from outreach_links
  where token = p_token and slug = p_slug;

  if v_link_id is null then
    return;
  end if;

  insert into outreach_profile_sessions (id, link_id, started_at, last_seen_at, max_scroll_pct, plays, link_taps)
  values (
    p_session_id,
    v_link_id,
    now(),
    now(),
    v_scroll_pct,
    case when p_play then 1 else 0 end,
    case when p_link_tap then 1 else 0 end
  )
  on conflict (id) do update set
    last_seen_at = now(),
    max_scroll_pct = greatest(outreach_profile_sessions.max_scroll_pct, excluded.max_scroll_pct),
    plays = outreach_profile_sessions.plays + excluded.plays,
    link_taps = outreach_profile_sessions.link_taps + excluded.link_taps;
end;
$$;

-- ── get_outreach_engagement ──────────────────────────────────────────────────
-- Called by VenueFindr (anon key). One row per requested token (even a token
-- with zero sessions still appears, via the left join, with zeroed-out
-- aggregates) — scoped to p_device_id same as get_outreach_clicks.
create or replace function public.get_outreach_engagement(
  p_device_id text,
  p_tokens text[]
)
returns table(
  token text,
  session_count bigint,
  longest_duration_seconds int,
  max_scroll_pct int,
  total_plays bigint,
  total_link_taps bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    l.token,
    count(s.id) as session_count,
    coalesce(max(extract(epoch from (s.last_seen_at - s.started_at)))::int, 0) as longest_duration_seconds,
    coalesce(max(s.max_scroll_pct), 0) as max_scroll_pct,
    coalesce(sum(s.plays), 0) as total_plays,
    coalesce(sum(s.link_taps), 0) as total_link_taps
  from outreach_links l
  left join outreach_profile_sessions s on s.link_id = l.id
  where l.device_id = p_device_id
    and l.token = any(p_tokens)
  group by l.token;
$$;
