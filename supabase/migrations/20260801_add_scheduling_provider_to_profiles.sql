-- Generalized scheduling link on profiles (2026-08-01). Same no-separate-table,
-- one-nullable-text-column-per-thing pattern as social_* / widget_* — read by the
-- profile-rendering side (sqrz-profiles) to render a booking/scheduling embed.
-- Applied via apply_migration on 2026-08-01.
--
-- Deliberately NO check constraint on scheduling_provider: the whole point is to
-- slot in cal_com / savvycal / etc. later WITHOUT a migration. The allowed set is
-- a UI-gated dropdown vocabulary ('calendly' only for now, more coming), not a DB
-- constraint. scheduling_provider lets the widget pick the right embed SDK instead
-- of guessing from scheduling_url's shape.
alter table public.profiles
  add column if not exists scheduling_provider text,
  add column if not exists scheduling_url text;

comment on column public.profiles.scheduling_provider is
  'Scheduling embed provider — ''calendly'' for now, null = none. Future: ''cal_com'', ''savvycal''. Intentionally unconstrained (no CHECK) so new providers need no migration; the allowed set is gated in the UI dropdown.';
comment on column public.profiles.scheduling_url is
  'The artist''s scheduling link, e.g. https://calendly.com/artist-handle. Paired with scheduling_provider, which tells the widget which embed SDK to render.';
