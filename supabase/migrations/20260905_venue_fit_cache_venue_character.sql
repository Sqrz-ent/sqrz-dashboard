-- generate-tour-plan v5: replace venue_size + vibe_types/vibe_types_key with
-- a single venue_character column on venue_fit_cache, matching the edge
-- function's new single-select input field. goal is untouched.
--
-- The table held only test/diagnostic rows from this feature's own build-and-
-- verify cycles (154 rows, confirmed live before writing this migration, not
-- assumed empty) — truncated here rather than backfilled, since there is no
-- way to derive a venue_character value from the old venue_size/vibe_types
-- combination and no real per-venue verdict data existed yet to preserve.

truncate table venue_fit_cache;

alter table venue_fit_cache
  drop constraint venue_fit_cache_venue_id_venue_size_goal_vibe_types_key_key,
  drop constraint venue_fit_cache_venue_size_check;

alter table venue_fit_cache
  drop column venue_size,
  drop column vibe_types,
  drop column vibe_types_key;

alter table venue_fit_cache
  add column venue_character text not null
    check (venue_character in ('bar_lounge', 'club_nightlife', 'live_music_hall'));

alter table venue_fit_cache
  add constraint venue_fit_cache_venue_id_venue_character_goal_key
    unique (venue_id, venue_character, goal);
