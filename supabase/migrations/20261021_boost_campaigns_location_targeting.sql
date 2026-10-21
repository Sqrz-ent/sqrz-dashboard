-- Campaign geo-targeting (2026-10-21, create-sheet slimdown follow-up) — a
-- city + radius the user picks in the create sheet (iOS: MKLocalSearchCompleter
-- for the city, a fixed 10/25/50/80 km radius picker). All nullable: older
-- campaigns have none, and meta-campaign-create keeps its existing worldwide
-- targeting exactly as-is whenever they're absent.
alter table boost_campaigns
  add column location_city text,
  add column location_latitude double precision,
  add column location_longitude double precision,
  add column location_radius_km integer;

comment on column boost_campaigns.location_city is 'Display name of the picked city (e.g. "Berlin, Germany") — not used for Meta targeting itself, latitude/longitude/radius are.';
comment on column boost_campaigns.location_radius_km is 'One of 10/25/50/80 (iOS UI fixed set) — 80km is Meta''s real custom_locations max radius (50mi).';
