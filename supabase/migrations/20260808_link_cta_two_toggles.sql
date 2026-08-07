-- Private link CTA: two independent toggles replace the single-choice
-- cta_source design (2026-08-08 follow-up).
--
-- NOTE ON DRIFT: cta_source was added and show_scheduling_cta/show_shop_widget
-- were applied directly to the live DB ahead of this migration being written
-- (no committed migration ever added cta_source either — same class of drift
-- flagged elsewhere in this repo's history). This file exists to stop the drift
-- here: it's written idempotently against the CURRENT live state so re-running
-- it is a no-op, and going forward this is the source of truth for the schema.
--
-- A link page can independently have a floating scheduling button
-- (show_scheduling_cta), an inline shop widget (show_shop_widget), both, or
-- neither — no single-choice column can express "both", hence the split.

alter table public.private_booking_links drop column if exists cta_source;

alter table public.private_booking_links
  add column if not exists show_scheduling_cta boolean not null default false;

alter table public.private_booking_links
  add column if not exists show_shop_widget boolean not null default false;

comment on column public.private_booking_links.show_scheduling_cta is
  'Renders the profile''s scheduling CTA as a FLOATING button (same placement as the profile page''s primary CTA) on this link''s hosted page.';
comment on column public.private_booking_links.show_shop_widget is
  'Renders the profile''s shop widget INLINE on this link''s hosted page (same ShopSection component the profile page uses).';
