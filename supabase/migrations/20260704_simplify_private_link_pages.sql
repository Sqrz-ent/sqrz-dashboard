-- Collapse book/download/event into a single 'internal' type.
-- NB: drop the old constraint BEFORE the UPDATE — otherwise setting page_type to
-- 'internal' violates the still-active book/download/event check.
ALTER TABLE private_booking_links DROP CONSTRAINT private_booking_links_page_type_check;

UPDATE private_booking_links SET page_type = 'internal'
WHERE page_type IN ('book', 'download', 'event');

-- Only internal | external going forward.
ALTER TABLE private_booking_links ADD CONSTRAINT private_booking_links_page_type_check
  CHECK (page_type = ANY (ARRAY['internal'::text, 'external'::text]));

-- No columns dropped — prefill_service, event_date, event_venue, event_city
-- stay as unused legacy columns on old rows, not wired into any new logic.
