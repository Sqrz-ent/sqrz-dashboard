-- External links redirect straight to external_url and have no identity on
-- sqrz.com, so they carry no slug. Allow link_slug to be null.
-- The unique index (profile_id, link_slug) treats NULLs as distinct, so multiple
-- slugless external links per profile do not conflict.
ALTER TABLE private_booking_links ALTER COLUMN link_slug DROP NOT NULL;

-- Clear slugs on existing external rows.
UPDATE private_booking_links SET link_slug = NULL
WHERE page_type = 'external' AND link_slug IS NOT NULL;
