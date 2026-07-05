-- Backfill the 2 existing external rows: give them slugs, promote to internal,
-- and copy external_url_label → cta_label so the label survives the type merge.
UPDATE private_booking_links
SET
  link_slug  = 'download-my-beats-remixes',
  page_type  = 'internal',
  cta_label  = COALESCE(cta_label, external_url_label)
WHERE id = '336e238b-8c7f-468b-8775-bb43132b1514';

UPDATE private_booking_links
SET
  link_slug  = 'listen-on-spotify',
  page_type  = 'internal',
  cta_label  = COALESCE(cta_label, external_url_label)
WHERE id = '64e410dd-ac71-4fc2-997f-4c0c17c8dc79';
