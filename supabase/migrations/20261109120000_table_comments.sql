-- Table comments only (2026-11-09). NOT APPLIED. Sets COMMENT ON TABLE for every public table with an ownership tag:
--   [SQRZ] [VenueFindr] [SHARED] [MARKETING] [DEPRECATED], then a one-line purpose, then any previous comment text.
-- No rename, no drop, no data change. Idempotent (re-running overwrites with the same text). See docs/database/tables.md.
-- Views (ad_spend_wallets, profile_analytics, profile_hubspot_enrichment, profile_views_counted) are documented there but not touched here.

begin;

comment on table public.profiles is '[SQRZ] Core profile row per public page (slug, branding, widgets, Action Button, scheduling/shop/external settings). profiles.id != auth.users.id; user_id links to auth.';
comment on table public.accounts is '[SQRZ] One account per auth login; owns profiles (profiles.account_id) and one wallet. | Previous comment: One account per auth login. profiles.account_id points here; all of a login''s profiles share one account_wallets row. user_id goes null (FK ON DELETE SET NULL) when the auth user is deleted — the account row survives so wallet/ledger history keeps a home; accounts_set_anonymized_at stamps anonymized_at when that happens.';
comment on table public.account_wallets is '[SQRZ] Ad-spend wallet balance, one row per account (replaced the per-profile wallet 2026-10-18).';
comment on table public.wallet_ledger_entries is '[SQRZ] Append-only wallet ledger (topup/allocation/deallocation/bonus/refund); trigger keeps account_wallets.balance_cents.';
comment on table public.management_fee_charges is '[SQRZ] Fee rows recorded at wallet top-up (SQRZ revenue), linked to the top-up ledger entry.';
comment on table public.ad_spend_wallets_legacy is '[DEPRECATED] Frozen snapshot of the old per-profile wallet balances (superseded by account_wallets 2026-10-18). Nothing reads or writes it. | Previous comment: Superseded 2026-10-18 by account_wallets (one wallet per account, not per profile) — see the ad_spend_wallets view. Kept as a frozen historical snapshot of per-profile balances at migration time; nothing reads or writes this table anymore.';
comment on table public.boost_campaigns is '[SQRZ] Boost/Grow campaigns (status pipeline booked → ... → completed), creative, targeting, Meta stats.';
comment on table public.campaign_budgets is '[SQRZ] Per-campaign allocated/spent budget (active/exhausted).';
comment on table public.campaign_templates is '[SQRZ] Config for Boost/Grow campaign templates (price, budgets, IAP product, Pro days, unlock rules). Edited by hand, read-only for clients. | Previous comment: Pure configuration for Boost/Grow campaign templates. Edited directly by Will (Table Editor, possibly Airtable-synced later) — no client ever writes to this table. boost_campaigns.campaign_template is a foreign key into this table''s id. See the column comments for what each field controls before editing.';
comment on table public.campaign_activations is '[SQRZ] One row per paid template activation (IAP), idempotent per transaction, incl. Pro grant bookkeeping.';
comment on table public.campaign_activation_products is '[DEPRECATED] OLD activation-IAP product list, superseded by campaign_templates.iap_product_id. | Previous comment: DEPRECATED 2026-10-25 — superseded by campaign_templates.iap_product_id. verify-campaign-activation and apple-consumable-webhook no longer read this table; left in place rather than dropped, per this project''s standing convention. Do not add new code against this table.';
comment on table public.campaign_advisor_runs is '[SQRZ] AI Campaign Advisor run log/cache per campaign.';
comment on table public.profile_advisor_runs is '[SQRZ] AI Profile Advisor run log per profile.';
comment on table public.boost_campaign_toggle_log is '[SQRZ] Audit log of pause/resume toggles on live campaigns.';
comment on table public.audiences is '[SQRZ] Saved targeting audiences per profile for campaign creation.';
comment on table public.profile_meta_connections is '[SQRZ] Connected Facebook Page / Instagram per profile (for ''use existing post'' campaigns).';
comment on table public.meta_ad_accounts is '[SQRZ] SQRZ-owned Meta ad account credentials (system user token). Service role only. | Previous comment: Meta Marketing API credentials for SQRZ-owned ad account(s) (advertiser-of-record model). System User token used by edge functions for Insights sync and campaign management. Service-role only.';
comment on table public.meta_insights_sync_log is '[SQRZ] Run history of the daily Meta Insights sync (pg_cron meta-insights-sync-daily). Service role only. | Previous comment: Run history for the scheduled Meta Insights API sync job. Service-role only.';
comment on table public.private_booking_links is '[SQRZ] Private link pages (hosted page, CTA toggles, cover + focal point).';
comment on table public.leads is '[SQRZ] Flat lead list (web form + inquiry chat); Active/Archived. Replaced the bookings pipeline.';
comment on table public.profile_inquiry_threads is '[SQRZ] One row per visitor inquiry chat thread (Stream channel inquiry_{id}).';
comment on table public.notifications is '[SQRZ] In-app/push notifications per profile (campaign_status, wallet_bonus, chat_request, ...).';
comment on table public.profile_services is '[SQRZ] Service listing rows per profile (title, price range, active flag).';
comment on table public.profile_videos is '[SQRZ] Video embeds per profile.';
comment on table public.profile_references is '[SQRZ] Reference/testimonial rows per profile.';
comment on table public.shop_products is '[SQRZ] Up to 4 shop products per profile (gumroad/shopify shop mode). | Previous comment: Product grid items for a profile''s active shop, when shop_provider is gumroad or shopify (not used for soundee, which is a single-link storefront via profiles.soundee_url). Max 4 products per profile, enforced by trigger below.';
comment on table public.profile_views is '[SQRZ] Page-view log for profile/link pages (attribution to campaigns, bot flag is_suspect).';
comment on table public.jitsu_events is '[SQRZ] Server-side engagement/click event stream from profile pages (service-role insert only).';
comment on table public.cookie_consents is '[SQRZ] Cookie-banner decisions on profile pages (anon insert; ip_hash only). domain column allows other sites.';
comment on table public.stripe_events is '[SQRZ] Stripe webhook idempotency/audit log.';
comment on table public.invite_codes is '[SQRZ] Beta invite codes (one per referrer profile).';
comment on table public.invite_code_redemptions is '[SQRZ] Who redeemed which invite code.';
comment on table public.ios_subscriptions is '[SQRZ] SQRZ Companion iOS subscription state (dark — flag companion_subscription_enabled is off).';
comment on table public.apple_webhook_events is '[SQRZ] Raw log of Apple server notifications (dark with ios_subscriptions).';
comment on table public.account_deletion_log is '[SQRZ] Audit trail for the delete-account edge function. | Previous comment: Audit trail for the delete-account edge function. service_role only (RLS on, no policies).';
comment on table public.pending_signups is '[DEPRECATED] Pre-signup slug reservation lookup used by the auth user-creation trigger; public signup flows have been removed.';
comment on table public.plans is '[DEPRECATED] Old subscription plans (booking_fee_pct etc.). plan_id is no longer used for gating anywhere (no SaaS tier during beta).';
comment on table public.locations is '[SHARED] Country list (iso_code, name, is_active). Used by profiles.location_iso, the dashboard/iOS pickers, VenueFindr and the marketing venues page.';
comment on table public.app_config is '[SHARED] Key/jsonb feature flags and limits (purchase_gate_enabled, companion_subscription_enabled, max_profiles_per_account, web_campaign_create_enabled once applied). Public read.';
comment on table public.beta_interest_submissions is '[MARKETING] Slug-checker ''available'' popup captures from the marketing site (anon insert). | Previous comment: Placeholder capture for the marketing-site slug-checker "available" popup (sqrz-cast). Anon-insert-only, no public read. Field set is a work in progress — extra jsonb holds anything not yet promoted to a real column.';
comment on table public.beta_slug_holds is '[MARKETING] Slug reservations created by the marketing-site beta request; consumed on profile creation. | Previous comment: Slug reservations from the marketing-site beta-request popup (sqrz-cast). Written only by the hubspot-beta-slug-request edge function, after a successful HubSpot contact sync. RLS on, no policies = service-role only. claimed_at null = still held/unclaimed. unique(slug) — see the app-level "already reserved" handling in the edge function for the resulting 23505 duplicate-key case.';
comment on table public.link_interest_events is '[MARKETING] Anon ''link interest'' pitch submissions (event_type, name, pitch, link). Owner unconfirmed — guess: marketing/links product.';
comment on table public.venues is '[VenueFindr] The venue database (Google Maps data, contacts, flags). Also read by the marketing site''s venues page.';
comment on table public."venues_toScrape" is '[VenueFindr] Backlog of venues to enrich via Google Maps/contacts (feeds area-fetch-worker via backlog_feed). | Previous comment: venues_toScrapeDup';
comment on table public.backlog_plan is '[VenueFindr] Plan rows driving backlog_feed (country/cohort/batch size/priority).';
comment on table public.dedup_clusters is '[VenueFindr] Duplicate-cluster analysis of the venues_toScrape list (cluster_id, is_dup, match_type). One-off working table. Owner confirmed by content; status unconfirmed.';
comment on table public.area_fetch_config is '[VenueFindr] Single-row config/guardrails for area-fetch-worker (enabled, daily/monthly caps, backlog regexes).';
comment on table public.area_fetch_tiers is '[VenueFindr] Tier definitions (record caps) for paid area fetches.';
comment on table public.area_fetch_requests is '[VenueFindr] Queue/log of venue collection jobs (area, city, backlog, contacts) run by area-fetch-worker.';
comment on table public.city_collections is '[VenueFindr] Per-city venue collection status for tour-route planning.';
comment on table public.city_requests is '[VenueFindr] Fast-track city requests (RevenueCat transaction ids) from the VenueFindr app.';
comment on table public.city_fetch_requests is '[DEPRECATED] Earlier per-city purchase log written after a fast-track IAP; never received a row (0 lifetime inserts). Superseded by area_fetch_requests query_mode=''city'' + city_collections.';
comment on table public.tour_plans is '[VenueFindr] Generated tour plans.';
comment on table public.tour_plan_config is '[VenueFindr] Single-row config for generate-tour-plan.';
comment on table public.tour_plan_usage is '[VenueFindr] Per-user tour-plan usage/limits.';
comment on table public.venue_fit_cache is '[VenueFindr] Cache of LLM venue-fit judgments for tour planning. | Previous comment: Caches Stage 3 LLM fit judgments for generate-tour-plan, keyed by venue + search parameter combination (not by route) so repeated searches with the same size/goal/vibe reuse prior judgments instead of re-querying the LLM. vibe_types_key is the sorted/joined form of vibe_types used for stable cache-key matching.';
comment on table public.venue_reports is '[VenueFindr] User reports about venues (e.g. wrong data).';
comment on table public.credit_balances is '[VenueFindr] VenueFindr credit wallet balances per user.';
comment on table public.credit_ledger is '[VenueFindr] VenueFindr credit ledger (purchase/spend/refund).';
comment on table public.credit_config is '[VenueFindr] Single-row credit config (signup credits).';
comment on table public.credit_costs is '[VenueFindr] Credit price per action (tour_plan, area_*).';
comment on table public.credit_packs is '[VenueFindr] Purchasable credit packs (RevenueCat product ids).';
comment on table public.outreach_links is '[VenueFindr] VenueFindr outreach links (?r= token) sent to venues. | Previous comment: One row per VenueFindr outreach link (token in the ?r= query param). RLS on, no policies — access only via the outreach_* RPCs.';
comment on table public.outreach_clicks is '[VenueFindr] Server-side click log per outreach link. | Previous comment: Server-side click log, one row per request carrying a valid ?r= token (see log_outreach_click). RLS on, no policies.';
comment on table public.outreach_profile_sessions is '[SHARED] Client-side engagement per page load on SQRZ profile pages reached via an outreach link (VenueFindr feature, written by the SQRZ profile site). | Previous comment: Client-side engagement per page load (id is client-generated, in-memory only — no cookies/localStorage). RLS on, no policies — written only via record_profile_engagement.';
comment on table public.outreach_profile_events is '[SHARED] Labeled engagement events (cta_tap/service_tap/contact_open/...) for an outreach session. | Previous comment: Labeled engagement events (cta_tap/service_tap/contact_open/contact_submit/download) for an outreach-tracked profile session. RLS on, no policies — written only via record_outreach_event, read only via get_outreach_events.';

commit;
