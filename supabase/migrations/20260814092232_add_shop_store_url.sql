-- Committed catch-up for a column that was applied live (via apply_migration)
-- earlier than any committed file — same drift pattern this repo has flagged
-- before (e.g. 20260808_link_cta_two_toggles). Version/name here match the
-- live-applied migration (supabase_migrations.schema_migrations version
-- 20260814092232 "add_shop_store_url") so `supabase db push` treats it as
-- already applied; `if not exists` keeps it idempotent either way.
--
-- shop_store_url: storefront homepage for the shopify/gumroad shop_provider
-- modes, powering the private-link page's floating "Visit Store" action button
-- (sqrz-profiles app/[slug]/page.tsx). Distinct from shop_products.buy_url
-- (per-product) and beatstars_url (a player-embed URL, not a clickable
-- storefront). beatstars uses its inline player embed, so it has no store
-- button and no shop_store_url use.
alter table public.profiles
  add column if not exists shop_store_url text;

comment on column public.profiles.shop_store_url is
  'Storefront homepage for the shopify/gumroad shop_provider modes (e.g. https://your-name.gumroad.com). Powers the private-link page''s floating "Visit Store" button. Distinct from shop_products.buy_url (per-product) and beatstars_url (player embed). null = no store link.';
