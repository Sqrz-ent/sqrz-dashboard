-- Meta ad delivery-status column (2026-08-08)
--
-- Backs the meta-status-webhook edge function: Meta pushes an ad's real
-- effective_status (ACTIVE / PAUSED / DISAPPROVED / WITH_ISSUES / ...) whenever
-- delivery state changes, and the webhook writes that raw value here.
--
-- THREE DISTINCT CONCEPTS, THREE DISTINCT COLUMNS — do not conflate:
--   * status               — SQRZ's own workflow lane (booked/in_review/live/...)
--   * meta_sync_status      — creation-technical state (creating/created/failed)
--   * meta_delivery_status  — Meta's raw effective_status as last reported by
--                             the webhook (this column). The single source of
--                             truth for real ad delivery, mapped INTO `status`
--                             by the webhook (ACTIVE->live, WITH_ISSUES/
--                             DISAPPROVED->needs_changes; PAUSED and transient
--                             states force no status change — see the function).

alter table public.boost_campaigns add column if not exists meta_delivery_status text;

comment on column public.boost_campaigns.meta_delivery_status is
  'Meta''s raw ad effective_status as last reported by the meta-status-webhook edge function (ACTIVE/PAUSED/DISAPPROVED/WITH_ISSUES/...). Distinct from status (SQRZ workflow lane) and meta_sync_status (creation-technical state).';
