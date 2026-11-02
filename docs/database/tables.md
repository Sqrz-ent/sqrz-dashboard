# Database tables — public schema map

Generated 2026-11-02 from a **read-only** inspection of Supabase project `fmjefvdtnmgdfauedpmg` plus all repos. Nothing was renamed, dropped, applied or written.
Companion migrations (**not applied**): `supabase/migrations/20261109120000_table_comments.sql` — sets a `[TAG]` + purpose comment on every table below; and `supabase/migrations/20261109130000_drop_deprecated_tables.sql` — drops `profiles.plan_id` + six deprecated tables (see "Cleanup 2026-11-09" below). Rows marked **dropping** are removed by that migration once applied; the comments migration runs first and still comments them.

**Repos searched:** sqrz-dashboard (app, edge functions, migrations, docs), sqrz-ios, sqrz (public profiles site), cast (marketing), sqrz-jobs, venuefindr-ios, plus the DB itself (functions, triggers, views, RLS policies, FKs, pg_cron) and the *deployed* edge-function sources (six deployed functions are not in this repo, see "Findings").
**Numbers:** row counts are exact `count(*)`; size is `pg_total_relation_size`; "last write" is max(created_at/updated_at) where the table has such a column, otherwise it says so. `pg_stat` row estimates were stale for some tables and were not used.

## Status legend
- **active** — in use.  
- **deprecated — safe to drop** — nothing reads or writes it.  
- **deprecated-but-referenced** — superseded, but something still references it (prerequisites listed).  
- **unknown — ask Will** — no reference found, can't prove it's dead.

## Summary
| Status | Count | Tables |
|---|---|---|
| active | 58 | all others |
| deprecated — dropping in `20261109130000` (not applied) | 6 | `ad_spend_wallets_legacy`, `campaign_activation_products`, `pending_signups`, `plans`, `profile_references`, `city_fetch_requests` |
| deprecated-but-referenced | 0 tables (1 view: `ad_spend_wallets`) | — |
| unknown — ask Will | 2 | `link_interest_events`, `dedup_clusters` |

66 tables in `public` (+4 views). Total ≈ 330 MB, of which `dedup_clusters` (148 MB), `venues` (61 MB) and `venues_toScrape` (42 MB) are ~76%.

## SQRZ (creator platform: dashboard, iOS app, profile pages)

| Table | Status | Purpose | Rows | Size | Last write | References |
|---|---|---|---:|---:|---|---|
| `profiles` | active | Core profile row per public page (slug, branding, widgets, Action Button, scheduling/shop/external settings). profiles.id != auth.users.id; user_id links to auth. | 14 | 344 kB | 2026-10-30 (updated) | dashboard app+fns (everything), sqrz-ios, sqrz (profiles site), cast (marketing counts); FK target of ~20 tables; triggers profiles_updated_at, profiles_set_account_id, on_profile_hubspot_sync, on_profile_created_mark_beta_slug_claimed; 5 RLS policies; many RPCs (handle_new_user, create_additional_profile, user_owns_profile, ...) |
| `accounts` | active | One account per auth login; owns profiles (profiles.account_id) and one wallet. | 12 | 48 kB | 2026-10-18 | dashboard app (3), hook_before_user_created, profiles_assign_account_id, user_owns_account, caller_account_is_beta/lab; FK from profiles, account_wallets, wallet_ledger_entries; trigger accounts_set_anonymized_at |
| `account_wallets` | active | Ad-spend wallet balance, one row per account (replaced the per-profile wallet 2026-10-18). | 2 | 24 kB | 2026-11-01 | dashboard (wallet), sqrz-ios (WalletViewModel), allocate_campaign_budget, apply_wallet_ledger_entry, reset_demo_account_on_login; ad_spend_wallets view; FK→accounts |
| `wallet_ledger_entries` | active | Append-only wallet ledger (topup/allocation/deallocation/bonus/refund); trigger keeps account_wallets.balance_cents. | 41 | 80 kB | 2026-11-01 | allocate/deallocate/reallocate_campaign_budget, complete_campaign_budget_payment, record_wallet_topup, reset_demo_account_on_login; triggers on_wallet_ledger_entry_insert (+hubspot, +meta budget sync); sqrz-ios; FK→accounts, profiles, boost_campaigns |
| `management_fee_charges` | active | Fee rows recorded at wallet top-up (SQRZ revenue), linked to the top-up ledger entry. | 23 | 48 kB | 2026-11-01 | record_wallet_topup; trigger management_fee_charges_updated_at; FK→profiles, wallet_ledger_entries |
| `ad_spend_wallets_legacy` **[DEPRECATED]** | deprecated — **dropping in 20261109130000** (code references removed) | Frozen snapshot of the old per-profile wallet balances (superseded by account_wallets 2026-10-18). Nothing reads or writes it. | 2 | 56 kB | 2026-08-17 (updated) | none in code, functions, triggers, views or policies. Only mention: migration 20261018_account_level_wallet.sql. Outbound FK→profiles (does not block a drop). |
| `boost_campaigns` | active | Boost/Grow campaigns (status pipeline booked → ... → completed), creative, targeting, Meta stats. | 5 | 112 kB | 2026-10-25 | dashboard app+fns (meta-*, hubspot-sync-deal, campaign-advisor, verify-campaign-activation, ...), sqrz-ios, sqrz profiles (utm attribution); pg_cron auto-complete-expired-campaigns; triggers set_campaign_utm, on_boost_campaign_hubspot_sync, on_campaign_status_notify, on_boost_campaign_submit_meta_create; 12 RPCs; FK target of campaign_budgets/activations/advisor_runs/leads/profile_views/jitsu_events/wallet_ledger_entries |
| `campaign_budgets` | active | Per-campaign allocated/spent budget (active/exhausted). | 1 | 64 kB | 2026-10-19 (updated) | allocate/deallocate/reallocate_campaign_budget, complete_campaign_budget_payment, apply_wallet_ledger_entry, reset_demo_account_on_login; dashboard; policy campaign_budgets_owner_select; FK→boost_campaigns |
| `campaign_templates` | active | Config for Boost/Grow campaign templates (price, budgets, IAP product, Pro days, unlock rules). Edited by hand, read-only for clients. | 18 | 104 kB | 2026-10-30 | dashboard (templates.ts, grow), sqrz-ios, meta-campaign-create, verify-campaign-activation, apple-consumable-webhook, ...; FK from boost_campaigns.campaign_template |
| `campaign_activations` | active | One row per paid template activation (IAP), idempotent per transaction, incl. Pro grant bookkeeping. | 0 | 64 kB | never in current data (17 lifetime inserts, all removed) | record_campaign_activation; verify-campaign-activation, apple-consumable-webhook; FK→profiles, boost_campaigns |
| `campaign_activation_products` **[DEPRECATED]** | deprecated — **dropping in 20261109130000** (code references removed) | OLD activation-IAP product list, superseded by campaign_templates.iap_product_id. | 2 | 64 kB | 2026-10-21 | STILL READ: apple-subscription-webhook/index.ts:177 (.from('campaign_activation_products')); mentioned in comments of apple-consumable-webhook and verify-campaign-activation; migrations 20261021/20261024/20261025 |
| `campaign_advisor_runs` | active | AI Campaign Advisor run log/cache per campaign. | 0 | 64 kB | none in current data (4 lifetime inserts, deleted) | campaign-advisor, profile-advisor, delete-account fns; policy 'Owner can view own campaign advisor runs'; FK→boost_campaigns |
| `profile_advisor_runs` | active | AI Profile Advisor run log per profile. | 1 | 48 kB | 2026-10-12 | profile-advisor, delete-account; sqrz-ios (dashboard home); FK→profiles |
| `boost_campaign_toggle_log` | active | Audit log of pause/resume toggles on live campaigns. | 0 | 48 kB | none in current data (4 lifetime inserts, deleted) | meta-campaign-toggle fn; migration 20261022; FK→boost_campaigns, profiles |
| `audiences` | active | Saved targeting audiences per profile for campaign creation. | 1 | 48 kB | 2026-10-26 | sqrz-ios (3); trigger audiences_before_write; FK from boost_campaigns.audience_id |
| `profile_meta_connections` | active | Connected Facebook Page / Instagram per profile (for 'use existing post' campaigns). | 2 | 48 kB | 2026-10-24 | meta-page-connect/connection-status/disconnect/posts, meta-campaign-create, meta-leadgen-webhook; sqrz-ios (3); dashboard; trigger set_updated_at |
| `meta_ad_accounts` | active | SQRZ-owned Meta ad account credentials (system user token). Service role only. | 2 | 48 kB | 2026-08-02 | 10 edge functions (meta-*); dashboard |
| `meta_insights_sync_log` | active | Run history of the daily Meta Insights sync (pg_cron meta-insights-sync-daily). Service role only. | 102 | 64 kB | 2026-11-02 | meta-insights-sync fn; pg_cron job meta-insights-sync-daily |
| `private_booking_links` | active | Private link pages (hosted page, CTA toggles, cover + focal point). | 7 | 176 kB | 2026-10-16 | dashboard, sqrz-ios, sqrz profiles ([slug] pages); get_analytics_page, get_link_metrics; FK from boost_campaigns.promote_link_id, profile_views.link_id, profiles.action_button_link_id; 4 policies |
| `leads` | active | Flat lead list (web form + inquiry chat); Active/Archived. Replaced the bookings pipeline. | 12 | 112 kB | 2026-11-01 (updated) | dashboard, sqrz-ios (Leads tab), create_booking_request, set_lead_status, get_campaign_metrics, get_analytics_page; trigger leads_updated_at; meta-leadgen-webhook, hubspot fns; FK→boost_campaigns, profiles, profile_inquiry_threads |
| `profile_inquiry_threads` | active | One row per visitor inquiry chat thread (Stream channel inquiry_{id}). | 8 | 152 kB | 2026-10-23 | dashboard (2), sqrz profiles (3), notify_new_inquiry trigger on_inquiry_created_notify; policies x4; FK from leads.thread_id |
| `notifications` | active | In-app/push notifications per profile (campaign_status, wallet_bonus, chat_request, ...). | 99 | 88 kB | 2026-10-26 | dashboard, sqrz-ios, apns-push; notify_campaign_status_change, notify_new_inquiry; trigger on_notification_insert_apns_push; 2 policies |
| `profile_services` | active | Service listing rows per profile (title, price range, active flag). | 9 | 80 kB | 2026-10-12 | dashboard, sqrz-ios, get_dashboard_home, hubspot fns; 2 policies (public_read, owner) |
| `profile_videos` | active | Video embeds per profile. | 10 | 48 kB | 2026-10-16 | dashboard, sqrz-ios, get_dashboard_home; 2 policies |
| `profile_references` | deprecated — **dropping in 20261109130000** (code references removed) | Reference/testimonial rows per profile. UI removed everywhere; last code reference was delete-account (removed 2026-11-09). | 14 | 48 kB | 2026-08-16 | delete-account (removed); 2 policies (dropped with the table) |
| `shop_products` | active | Up to 4 shop products per profile (gumroad/shopify shop mode). | 2 | 48 kB | 2026-08-07 | dashboard, sqrz-ios, sqrz profiles ShopSection; trigger shop_products_max_four_check; 2 policies |
| `profile_views` | active | Page-view log for profile/link pages (attribution to campaigns, bot flag is_suspect). | 13,226 | 6.4 MB | 2026-11-01 | sqrz profiles (/api/track, view tracker), analytics RPCs via profile_views_counted view, sync_campaign_stats, flag_suspect_profile_views (pg_cron flag-suspect-profile-views, hourly); triggers on_profile_view_inserted, on_profile_view_resolve_campaign |
| `jitsu_events` | active | Server-side engagement/click event stream from profile pages (service-role insert only). | 15,612 | 18 MB | 2026-11-02 | sqrz profiles (lib/tracking, /api/track); analytics RPCs, build_engagement_funnel; FK→boost_campaigns |
| `cookie_consents` | active | Cookie-banner decisions on profile pages (anon insert; ip_hash only). domain column allows other sites. | 330 | 120 kB | 2026-10-25 | sqrz profiles: app/api/cookie-consent/route.ts; policy cookie_consents_anon_insert |
| `stripe_events` | active | Stripe webhook idempotency/audit log. | 135 | 80 kB | 2026-11-01 | dashboard app/routes/api.stripe.webhook.tsx |
| `invite_codes` | active | Beta invite codes (one per referrer profile). | 4 | 48 kB | 2026-10-04 | redeem-invite-code, get-or-create-invite-code, delete-account; record_invite_code_redemption; FK→profiles |
| `invite_code_redemptions` | active | Who redeemed which invite code. | 6 | 64 kB | no timestamp column | record_invite_code_redemption, redeem-invite-code; FK→invite_codes |
| `ios_subscriptions` | active | SQRZ Companion iOS subscription state (dark — flag companion_subscription_enabled is off). | 0 | 40 kB | never written | apple-subscription-webhook, get_companion_subscription_status; trigger ios_subscriptions_updated_at; FK→profiles |
| `apple_webhook_events` | active | Raw log of Apple server notifications (dark with ios_subscriptions). | 0 | 24 kB | never written | apple-subscription-webhook, apple-consumable-webhook |
| `account_deletion_log` | active | Audit trail for the delete-account edge function. | 16 | 32 kB | 2026-10-09 | delete-account fn; FK→profiles |
| `pending_signups` **[DEPRECATED]** | deprecated — **dropping in 20261109130000** (code references removed) | Pre-signup slug reservation lookup used by the auth user-creation trigger; public signup flows have been removed. | 0 | 32 kB | none in current data (12 lifetime inserts+deletes) | STILL READ: DB function handle_new_user (reads it); docs/auth/web-login-fallback.md; migration 20261102_drop_dead_profile_columns mentions it |
| `plans` **[DEPRECATED]** | deprecated — **dropping in 20261109130000** (code references removed) | Old subscription plans (booking_fee_pct etc.). plan_id is no longer used for gating anywhere (no SaaS tier during beta). | 2 | 32 kB | 2026-03-16 created (stats analyzed 2026-06-29) | STILL REFERENCED: FK profiles_plan_id_fkey (profiles.plan_id → plans); DB function get_dashboard_home; policies plans_public_read/plans_service_write; view profile_hubspot_enrichment selects profiles.plan_id (the column, not the table). Docs only: cast terms page text, adquick outlet doc ('plans' = AdQuick's own API objects, unrelated) |

## SHARED (used by more than one product)

| Table | Status | Purpose | Rows | Size | Last write | References |
|---|---|---|---:|---:|---|---|
| `locations` | active | Country list (iso_code, name, is_active). Used by profiles.location_iso, the dashboard/iOS pickers, VenueFindr and the marketing venues page. | 196 | 112 kB | 2026-03-16 | FK profiles_location_iso_fkey; dashboard, sqrz-ios, venuefindr-ios, cast; policies locations_public_read, locations_service_write |
| `app_config` | active | Key/jsonb feature flags and limits (purchase_gate_enabled, companion_subscription_enabled, max_profiles_per_account, web_campaign_create_enabled once applied). Public read. | 4 | 32 kB | 2026-10-21 (updated) | dashboard app/lib/flags.server.ts + pro gate, sqrz-ios (3), create_additional_profile, audiences_before_write |
| `outreach_profile_sessions` | active | Client-side engagement per page load on SQRZ profile pages reached via an outreach link (VenueFindr feature, written by the SQRZ profile site). | 5 | 40 kB | no timestamp column | record_profile_engagement, get_outreach_engagement; trigger outreach_session_started; sqrz profiles; venuefindr-ios (reads) |
| `outreach_profile_events` | active | Labeled engagement events (cta_tap/service_tap/contact_open/...) for an outreach session. | 10 | 48 kB | 2026-10-13 | record_outreach_event, get_outreach_events; sqrz profiles; venuefindr-ios (reads); FK→outreach_profile_sessions |

## MARKETING (sqrz.com marketing site / HubSpot capture)

| Table | Status | Purpose | Rows | Size | Last write | References |
|---|---|---|---:|---:|---|---|
| `beta_interest_submissions` | active | Slug-checker 'available' popup captures from the marketing site (anon insert). | 0 | 32 kB | none in current data (2 lifetime inserts, deleted) | cast marketing site (1 file); policy beta_interest_submissions_anon_insert |
| `beta_slug_holds` | active | Slug reservations created by the marketing-site beta request; consumed on profile creation. | 0 | 48 kB | none in current data (5 lifetime inserts, 3 deleted) | hubspot-beta-slug-request fn (writes); DB function mark_beta_slug_claimed (trigger on_profile_created_mark_beta_slug_claimed on profiles) |
| `link_interest_events` | unknown — ask Will | Anon 'link interest' pitch submissions (event_type, name, pitch, link). Owner unconfirmed — guess: marketing/links product. | 15 | 32 kB | 2026-09-03 | NONE in any repo, function, trigger, view or cron. Only an anon INSERT policy ('Anon can log link interest') — so something external (a static form or a Webflow/Typeform hook) may write it. |

## VenueFindr (venue database, tour planning, credits, outreach)

| Table | Status | Purpose | Rows | Size | Last write | References |
|---|---|---|---:|---:|---|---|
| `venues` | active | The venue database (Google Maps data, contacts, flags). Also read by the marketing site's venues page. | 25,074 | 61 MB | 2026-10-15 | venuefindr-ios, cast (/venues page, get_random_venues), area-fetch-worker, generate-tour-plan, quick-action, match-venues-hubspot; get_random_venues, venues_in_bounds, report_venue, resolve_venue_cities, backlog_insert_venue_from_payload, contacts_queue; trigger venues_flag_sync (→ sync-venue-flags); FK from outreach_links, venue_fit_cache; policy 'Public read venues' |
| `venues_toScrape` | active | Backlog of venues to enrich via Google Maps/contacts (feeds area-fetch-worker via backlog_feed). | 60,335 | 42 MB | 2026-10-13 | area-fetch-worker; backlog_feed, backlog_queue, contacts_queue; trigger backlog_rescue; pg_cron backlog-feeder (every 5 min). RLS is OFF on this table. |
| `backlog_plan` | active | Plan rows driving backlog_feed (country/cohort/batch size/priority). | 53 | 64 kB | no timestamp column (71 updates since stats reset) | backlog_feed (pg_cron backlog-feeder) |
| `dedup_clusters` | unknown — ask Will | Duplicate-cluster analysis of the venues_toScrape list (cluster_id, is_dup, match_type). One-off working table. Owner confirmed by content; status unconfirmed. | 90,024 | 148 MB | no timestamp column (stats analyzed 2026-09-03) | NONE in any repo, function, trigger, view, policy or cron. RLS is OFF. Largest table in the schema. |
| `area_fetch_config` | active | Single-row config/guardrails for area-fetch-worker (enabled, daily/monthly caps, backlog regexes). | 1 | 64 kB | 2026-10-10 | area-fetch-worker, request-area-fetch; backlog_queue, contacts_queue |
| `area_fetch_tiers` | active | Tier definitions (record caps) for paid area fetches. | 3 | 48 kB | no timestamp column | request-area-fetch; FK from area_fetch_requests.tier |
| `area_fetch_requests` | active | Queue/log of venue collection jobs (area, city, backlog, contacts) run by area-fetch-worker. | 145 | 368 kB | 2026-10-15 | area-fetch-worker, request-area-fetch; area_fetch_spend, backlog_feed, backlog_queue, contacts_queue; pg_cron area-fetch-worker-tick (every 10 min); venuefindr-ios (via fn); FK from city_collections |
| `city_collections` | active | Per-city venue collection status for tour-route planning. | 7 | 32 kB | 2026-10-13 | area-fetch-worker, generate-tour-plan; FK→area_fetch_requests |
| `city_requests` | active | Fast-track city requests (RevenueCat transaction ids) from the VenueFindr app. | 4 | 32 kB | 2026-08-31 | venuefindr-ios FilterState.swift; fast_track_city, get_city_request_count, is_city_fast_tracked |
| `city_fetch_requests` **[DEPRECATED]** | deprecated — **dropping in 20261109130000** (code references removed) | Earlier per-city purchase log written after a fast-track IAP; never received a row (0 lifetime inserts). Superseded by area_fetch_requests query_mode='city' + city_collections. | 0 | 16 kB | never written | STILL REFERENCED: venuefindr-ios CityFetchService.swift (.from('city_fetch_requests') insert), PurchasesManager.swift/IAPConfig.swift comments; migration 20260904_create_city_fetch_requests.sql; 1 policy. No DB functions/triggers/views. |
| `tour_plans` | active | Generated tour plans. | 6 | 448 kB | 2026-10-14 | generate-tour-plan, area-fetch-worker; venuefindr-ios; 1 policy |
| `tour_plan_config` | active | Single-row config for generate-tour-plan. | 1 | 32 kB | 2026-10-11 | generate-tour-plan |
| `tour_plan_usage` | active | Per-user tour-plan usage/limits. | 10 | 48 kB | 2026-10-14 | generate-tour-plan |
| `venue_fit_cache` | active | Cache of LLM venue-fit judgments for tour planning. | 708 | 288 kB | no timestamp column (1128 inserts since stats reset) | generate-tour-plan; FK→venues |
| `venue_reports` | active | User reports about venues (e.g. wrong data). | 87 | 64 kB | 2026-10-26 | report_venue RPC |
| `credit_balances` | active | VenueFindr credit wallet balances per user. | 1 | 24 kB | 2026-10-14 | credits fn; credits_ensure_account, credits_grant, credits_spend |
| `credit_ledger` | active | VenueFindr credit ledger (purchase/spend/refund). | 13 | 80 kB | 2026-10-14 | credits fn, area-fetch-worker, request-area-fetch; credits_* RPCs |
| `credit_config` | active | Single-row credit config (signup credits). | 1 | 24 kB | 2026-10-11 | credits_ensure_account |
| `credit_costs` | active | Credit price per action (tour_plan, area_*). | 9 | 32 kB | no timestamp column | credits, request-area-fetch fns |
| `credit_packs` | active | Purchasable credit packs (RevenueCat product ids). | 5 | 48 kB | no timestamp column | credits fn |
| `outreach_links` | active | VenueFindr outreach links (?r= token) sent to venues. | 5 | 64 kB | 2026-10-14 | create_outreach_link(_v2), mark_outreach_sent, get_outreach_*, log_outreach_click, record_*; triggers outreach_link_created; venuefindr-ios (RPCs); sqrz profiles (RPCs); FK→venues |
| `outreach_clicks` | active | Server-side click log per outreach link. | 5 | 48 kB | no timestamp column | log_outreach_click, get_outreach_clicks; sqrz profiles middleware; FK→outreach_links |

## Views (not table-commented)
| View | Status | Notes |
|---|---|---|
| `ad_spend_wallets` | deprecated-but-referenced | Read-compat view over `account_wallets` (shape of the old per-profile table). Still read by sqrz-ios (`WalletViewModel`/`AllocationViewModel`). Remove after those read `account_wallets` directly. |
| `profile_analytics` | active | Used by `profile-advisor`. |
| `profile_hubspot_enrichment` | active | View over `profiles` for HubSpot enrichment (`hubspot-beta-slug-request` header comment). Selects `profiles.plan_id` — update before dropping that column. |
| `profile_views_counted` | active | `profile_views WHERE NOT is_suspect`; every analytics RPC reads it. |

## Cleanup 2026-11-09 — tables being dropped (migration written, NOT applied)
`supabase/migrations/20261109130000_drop_deprecated_tables.sql` drops `profiles.plan_id` (+ FK `profiles_plan_id_fkey`) and these tables, using plain `DROP TABLE` (no CASCADE, so it aborts if anything unexpected still depends on them). All code references were removed first:

| Table | Code removed | DB objects rewritten in the migration |
|---|---|---|
| `campaign_activation_products` | `apple-subscription-webhook` now looks up `campaign_templates.iap_product_id` (both product ids exist there, status active → same forwarding behaviour) | — |
| `pending_signups` | — | `handle_new_user` recreated without the lookup/DELETE (otherwise identical) |
| `plans` + `profiles.plan_id` | sqrz (profiles site): selects, tracking `user_tier`, `Services` prop, inquiry server, privacy-page Stripe section; sqrz-dashboard: `PRICE_TO_PLAN`, home loader `planName`/`refCode`; sqrz-ios: `Profile.planId` | `get_dashboard_home` recreated without `planName`/`hasRefs`; view `profile_hubspot_enrichment` recreated without `plan_id`; trigger `on_profile_hubspot_sync` recreated without `plan_id` in its column list (a column-list trigger would block `DROP COLUMN`) |
| `profile_references` | `delete-account` no longer deletes from it (no iOS / profiles / web code existed) | — |
| `city_fetch_requests` | venuefindr-ios `CityFetchService` removed; fast-track purchases now call the existing `fast_track_city` RPC (writes `city_requests`, `fast_tracked = true`) | — |
| `ad_spend_wallets_legacy` | none needed | — |

Also removed (no table involved): `sqrz/components/LeadCapture.tsx` (wrote the non-existent `intent_events`), cast `/venues` page (wrote the non-existent `venue_contributors`).

**Data lost on apply:** `profiles.plan_id` (3 profiles have value 1), plus the rows listed in the migration header (`profile_references` 14 rows is the only table with real content).

**Apply order:** deploy `apple-subscription-webhook` + `delete-account` and the dashboard + profiles-site builds first, then apply.

**Still open — not dropped:**
| Item | Status | Prerequisite |
|---|---|---|
| `ad_spend_wallets` view | deprecated-but-referenced | sqrz-ios `Features/Account/ExitAccountSheet.swift` (~line 244) still reads it; switch to `account_wallets` first |
| `dedup_clusters` (148 MB) | unknown — untouched | ask Will |
| `link_interest_events` | unknown — untouched | ask Will who writes it |
| `venues_toScrape` | active — untouched | — |

## Findings worth a look (not changed)
1. **(Resolved 2026-11-09 — code removed)** **Code referencing tables that don't exist in `public`:** `cast/src/routes/venues/+page.svelte` upserts into `venue_contributors`; `sqrz/components/LeadCapture.tsx` inserts into `intent_events`. Both would fail at runtime (or are silently swallowed).
2. **Deployed edge function `generate-invoice` reads the dropped `invoices` table** — dead; nothing can call it successfully. Candidate for deletion.
3. **Six deployed edge functions are not in `sqrz-dashboard/supabase/functions`:** `area-fetch-worker`, `request-area-fetch`, `credits`, `quick-action`, `sync-venue-flags`, `generate-invoice` (the first three are the VenueFindr backend; `quick-action` = one-off HubSpot company matching into `venues`; `sync-venue-flags` = HubSpot flag sync invoked by trigger `venues_flag_sync`). Their source exists only on Supabase; consider committing it.
4. **RLS is OFF** on `dedup_clusters` and `venues_toScrape` (both large VenueFindr pipeline tables; the anon key can read/write them unless grants are revoked). Worth confirming grants.
5. **Stale `pg_stat` estimates:** several tables show a different row estimate than the true count (e.g. `pending_signups` est 1 vs 0, `beta_interest_submissions` est 1 vs 0); this doc uses exact counts.
6. `venues_toScrape` has the table comment `venues_toScrapeDup` — looks like a leftover from a rename/copy; kept after the tag in the migration.
7. `plans`' write policy is named `plans_service_write` with role `{public}` (same for `locations_service_write`) — the policy name says service role; check the `USING`/`WITH CHECK` really restricts to `service_role`.

## Method notes / limits
- `venuefindr-ios` was read from the `sqrz-workspace` repo (`venuefindr-ios/VenueFindr`); other app copies in that workspace are empty submodule stubs, so `sqrz` (profiles), `cast` and `sqrz-jobs` were read from their own repos. `sqrz-jobs` (Airtable-backed) references no table.
- Ownership of `outreach_profile_*` is **[SHARED]**: schema/comment says VenueFindr outreach, but rows are written by the SQRZ profile site via RPCs.
- Anything reached only through HubSpot/Webflow/Airtable automations outside the repos could not be seen — that's why `link_interest_events` is "unknown".
