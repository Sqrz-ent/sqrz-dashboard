-- Paid links are retired (checkout + PaymentGateCta already deleted; iOS's
-- CreateLinkView and Models/PrivateBookingLink.swift dropped their
-- payment_gate/price/currency fields earlier). This migration removes the
-- remaining leftovers: the payment_gate_clicks/payment_gate_unlocks keys in
-- get_analytics_page (fed by jitsu_events event_type payment_gate_clicked/
-- payment_gate_unlocked — no UI anywhere emits or displays these anymore)
-- and the now-dead private_booking_links.payment_gate/price/currency columns
-- themselves. Confirmed before writing: no triggers, policies, views, or
-- other functions reference any of the three columns.
--
-- get_analytics_page's real body lives under get_analytics_page__unchecked
-- (public.get_analytics_page is a thin access-check wrapper added by
-- 20261026_analytics_access_lockdown.sql) — edit that one, same
-- pg_get_functiondef + text-replace pattern as the other 2026-10-25 additive
-- migrations in this file.
do $$
declare
  def text := pg_get_functiondef('public.get_analytics_page__unchecked(uuid,integer)'::regprocedure);
  stripped text;
begin
  if def ~ 'payment_gate_clicks' then
    stripped := regexp_replace(
      def,
      $r$'payment_gate_clicks', \(\s*select count\(\*\) from jitsu_events\s*where profile_id = p_profile_id and event_type = 'payment_gate_clicked'\s*and created_at > now\(\) - \(p_days \|\| ' days'\)::interval\s*\),\s*'payment_gate_unlocks', \(\s*select count\(\*\) from jitsu_events\s*where profile_id = p_profile_id and event_type = 'payment_gate_unlocked'\s*and created_at > now\(\) - \(p_days \|\| ' days'\)::interval\s*\),\s*$r$,
      '',
      'n'
    );
    if stripped = def then
      raise exception 'payment_gate_clicks/unlocks pattern not matched — aborting to avoid a silent no-op';
    end if;
    execute stripped;
  end if;
end $$;

-- private_booking_links: drop the dead payment-gate columns outright.
alter table public.private_booking_links
  drop column if exists payment_gate,
  drop column if exists price,
  drop column if exists currency;
