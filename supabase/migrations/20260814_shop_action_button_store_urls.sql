-- Storefront-link fields powering the private-link page's floating action
-- button ("Visit [Provider] Store"), which becomes mutually exclusive with
-- Scheduling (see the Shop/Scheduling exclusivity work, 2026-08-14).
--
-- beatstars_store_url already existed live (applied directly at some earlier
-- point with no migration on record — the same undocumented-drift pattern
-- flagged elsewhere in this repo's CLAUDE.md) — `add column if not exists`
-- here is a no-op for it and just catches up its migration history + comment.
-- shop_store_url is new: a single storefront URL shared by the shopify/
-- gumroad shop_provider modes, distinct from shop_products.buy_url (which is
-- per-product, up to 4 rows, no store-level link previously existed).
-- Applied via apply_migration on 2026-08-14.
alter table public.profiles
  add column if not exists beatstars_store_url text,
  add column if not exists shop_store_url text;

comment on column public.profiles.beatstars_store_url is
  'BeatStars storefront homepage (e.g. https://artist.beatstars.com/) - a real clickable link, distinct from beatstars_url which holds the player EMBED url (player.beatstars.com/?storeId=...) for the inline iframe widget. Powers the private-link page''s floating action button ("Visit BeatStars Store").';

comment on column public.profiles.shop_store_url is
  'Storefront URL for the shopify/gumroad shop_provider modes - one shop-homepage link, distinct from shop_products.buy_url (per-product). Powers the private-link page''s floating action button ("Visit Shopify/Gumroad Store"). Not used for beatstars (see beatstars_store_url).';
