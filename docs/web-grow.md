# Web Grow — mirrors the iOS Grow tab

> **Web campaign creation is behind a switch (2026-11-02).** `app_config.web_campaign_create_enabled`
> (jsonb boolean, **default `false`**; migration `20261108120000_web_campaign_create_flag.sql`, not
> applied). While false: the template cards are display-only (no create link), and
> `/grow/campaigns/new/:templateId` — both its loader and its action — and
> `/api/location-search` redirect to Grow / return 403, so creation can't be reached by URL
> either. Set it to `true` (Table Editor) to turn it on; read server-side
> (`app/lib/flags.server.ts`) and cached ~60 s, so a change takes up to a minute to show. A missing
> row or failed read keeps it off. All create-campaign code is intact.

Status: built 2026-11-02 (code only — no migration, nothing applied or deployed
by me). Sources read: `sqrz-ios` `Features/Grow/GrowTabView.swift`,
`Features/Boost/BoostView.swift` (template cards, `NewBoostCampaignSheet`,
`BoostContentSheet`, pipeline), `Features/Links/LinksView.swift`,
`Features/Analytics/*`, `Core/Social/MetaConnectionService.swift`; and in this repo
the `record_campaign_activation` / `verify-campaign-activation` /
`apple-consumable-webhook` / `meta-campaign-create` code and migrations.

**The one iOS-only action is paying for / activating a campaign (the IAP).**
Everything else in Grow is on the web, except the items listed under "Not mirrored".

---

## 1. iOS investigation

### Grow tab structure
`GrowTabView` is a pill bar, one tab mounted at a time:
**Grow** (template cards = start a campaign) · **Campaigns** (pipeline) ·
**Links** · **Analytics**. Open to every user. Web mirrors this at `/grow`
with `?tab=grow|campaigns|links|analytics` (moved from `/analytics`, which
now redirects here).

### Template cards (Grow tab)
Rows of `campaign_templates` (RLS hides `hidden` and, for non-beta accounts, beta
rows), kept when `status` is `active`/`coming_soon` and inside
`available_from/until`, ordered by `sort_order`. Card state, in this order:
1. `coming_soon` → compact greyed row, not tappable.
2. `access_tier = premium` without `grow_access` → locked (can't occur on web: the
   dashboard is Pro-gated).
3. **Unlock rule** (`unlock_template_ids`, `unlock_min_count`, `unlock_label`): locked
   until the profile has ≥ N of its own campaigns from those templates that are
   `live`/`completed`; greyed card with the label on top.
4. non-Meta `outlet` → Lab workflow sheet (lab accounts only) — web shows "Set up in the app".
5. otherwise tappable → create sheet. "More info" expands `long_description`;
   "Includes X of Pro" from `pro_days`.

### Create flow (`NewBoostCampaignSheet`, then `BoostContentSheet`)
Create sheet fields (all validated client-side; the DB has no extra checks):
- **Name** (required) · **What to promote** (profile or an active *internal*
  `private_booking_links` row — only if `allow_destination_choice`).
- **Ad budget** — preset pills from `budget_options` (required for self-serve).
- **End** — `end_options`: "when the budget is used up" (`end_mode='budget'`,
  `daily_budget_cents = total ÷ 7`) and/or "on a date" (`end_mode='date'`, future `ends_at`).
- **Location** (required): city + radius 10/25/50/80 km → `location_city/latitude/longitude/radius_km`.
  iOS uses MapKit's on-device completer.
- **Target audience** free text; optional saved **audiences** (table `audiences`).
- Insert into `boost_campaigns` with `campaign_template`, `campaign_type='boost'`,
  `channels=['meta']`, `budget_amount` (the chosen dollars, persisted so the budget step
  can read it back), `utm_url`, `starts_at`, **`status='booked'`**.
- The **creative** is *not* in this sheet. It's `BoostContentSheet`, opened from the
  pipeline card ("Add your content →") for `booked`/`needs_changes`:
  - `creative_source='upload'` (also the fallback, e.g. `lead_form`): image/video
    (≤ 50 MB; images re-encoded to JPEG 0.85) uploaded to bucket **`campaign-creative`** at
    `{profileId lowercase}/{campaignId lowercase}.{ext}` → `creative_asset_url`; plus
    format (story/feed/classic), message, headline, optional description, CTA
    (book_now/learn_more/contact_us). If the profile has an active Page connection
    (`profile_meta_connections`), "use an existing post" is offered instead.
  - `existing_post`: pick one of the connected Page's recent Facebook/Instagram posts
    (edge function **`meta-page-posts`**), `post_source` limits to one platform,
    `requires_eligibility_check` blocks ineligible Instagram posts,
    `requires_connected_page` demands the connection; no format/message/CTA.
  - `video_link`: a YouTube link, normalised, with an explicit "Yes, promote this video".
  - Submit writes the creative columns and sets `status='in_review'` directly (client write).
- **Contact templates** (`delivery='contact'`): the same sheet in "request mode" — name,
  destination, location, audience, goals (→ `notes`), a loose budget (pills, or a free
  amount ≥ `ad_budget_min`); inserted with `status='pending'`, `is_managed=true` (shown as
  "Requested"); then the HubSpot discovery-call link opens, prefilled with
  email/first/last name. HubSpot deal sync is done by existing DB triggers on
  `boost_campaigns`. No payment.

### Status lifecycle and where payment happens
```
create sheet:   insert  ──►  booked   (a draft; "Add your content →")
                  │ same sheet, immediately: StoreKit purchase of
                  │ campaign_templates.iap_product_id   ◄── PAYMENT #1 (activation IAP, iOS only)
                  ▼ verify-campaign-activation → record_campaign_activation
              awaiting_budget   ("Add Budget →" premium / "Pay Budget →" free)
                  │ allocate_campaign_budget  or  complete_campaign_budget_payment
                  │ (ad spend from the wallet / Stripe — separate money, web top-up exists)
                  ▼
              in_review ──► (meta-campaign-create fires, needs a creative) ──► approved / needs_changes / rejected
                  ▼
                live ⇄ paused (is_paused) ──► completed ──(allocate again)──► pending → …
request:        pending + is_managed  ("Requested")  — no payment
```
Payment #1 (the **activation IAP**) is the only iOS-exclusive step. Ad budget funding
(wallet allocation / card) is a separate step after it.

### Can iOS pick up a campaign created elsewhere and waiting for payment?
**No — not before this change.** The activation purchase only ever ran inside
`NewBoostCampaignSheet.launchWithActivation`, immediately after that sheet's own insert.
A `booked` card had only "Add your content →", and that sheet's Submit moves the row
to `in_review` **without any payment** (see "Findings"). The existing resume actions
("Add/Pay Budget →") only exist for `awaiting_budget`, i.e. *after* activation.

**Smallest iOS change (done):** an **"Activate campaign →"** button on `booked`,
non-managed pipeline cards (`BoostView.activateButton` / `activateCampaign`): the same
StoreKit purchase for the template's `iap_product_id` (`appAccountToken` = profile id),
POST to the existing `verify-campaign-activation`, reload. The campaign then becomes
`awaiting_budget` and the existing budget buttons take over, reading the
`budget_amount` the web saved. No new edge function, table or schema.

### Findings (not changed — flagging)
- `BoostContentSheet.submit` sets `status='in_review'` straight from the client, which
  fires `meta-campaign-create` with **no payment check**. A `booked` campaign can reach
  Meta without being activated if the user taps "Add your content → Submit".
- In the IAP flow a campaign is `awaiting_budget` after activation, where
  `canAddContent` is false — so there is no in-app step to add creative after paying;
  `meta-campaign-create` then fails with "no creative". Collecting the creative
  **before** payment is therefore the right order — which is what the web form does.

---

## 2. What the web does

| Area | Web | File |
|---|---|---|
| Grow pills (same order) | `?tab=` | `routes/_app.grow.tsx`, `components/GrowTabs.tsx` |
| Template cards | same table, window, unlock, coming-soon, "More info", "Includes X of Pro" | `components/TemplateCards.tsx`, `lib/templates.ts` |
| Create campaign | `/grow/campaigns/new/:templateId` — all fields above + creative | `routes/_app.grow.campaigns.new.$templateId.tsx` |
| Contact templates | request → `pending`/`is_managed` → "Book your call" (HubSpot, prefilled) | same file |
| Pipeline | existing read-only pipeline (+ "Complete payment in the SQRZ app" on `booked`) | `components/CampaignPipeline.tsx` |
| Links | read-only list + 30-day stats + detail (`get_link_metrics`) | `components/GrowLinks.tsx`, `routes/_app.grow.links.$id.tsx` |
| Analytics | `get_analytics_page` (1/7/30/90 days) | `components/GrowAnalytics.tsx` |

Self-serve campaigns are saved **exactly like iOS before payment**: `status='booked'`,
`budget_amount` = chosen dollars, `end_mode`/`ends_at`/`daily_budget_cents`,
location, `utm_url`, and the creative columns already filled in. The page then says
**"Complete payment in the SQRZ app"**; there is no web checkout.

Creative upload happens **in the browser** (the logged-in Supabase browser client) to the same
bucket and path as iOS — `campaign-creative/{profileId}/{campaignId}.{ext}`, lowercased —
*before* the row is inserted (the campaign id is generated client-side), so large videos
never pass through the serverless request-size limit. The server action checks the URL is
inside that exact folder.

All reads/writes use the signed-in user's Supabase client (RLS applies): `boost_campaigns`
insert, `campaign_templates`, `private_booking_links`, `profile_meta_connections`,
`get_analytics_page`, `get_link_metrics`, and the `meta-page-posts` edge function.
Pro gate unchanged (every route here enforces it).

### Differences from iOS (deliberate or unavoidable)
- **Location search**: iOS uses MapKit on-device; the web uses an OpenStreetMap Nominatim
  proxy (`/api/location-search`, Pro + login only, debounced). Same stored fields. Nominatim's
  usage policy allows light use only — if volume grows, switch to a keyed geocoder.
- **Images are uploaded as-is**, not re-encoded to JPEG (iOS does). `meta-campaign-create`
  uploads from the URL; if PNG/WebP ever misbehaves, convert client-side.
- **Not mirrored:** saved **audiences** (apply/save), **creating, editing, starring and deleting
  links**, the per-campaign Refresh/Pause/Allocate actions, Lab (non-Meta outlet) workflows, and
  the Facebook Page *connection* flow (connect in the app, then pick posts on the web).
  Where iOS has an action the web shows "Manage this campaign in the SQRZ app".
- A `video_link` campaign is stored as `video_link_url` (normalised) like iOS.

## 3. Rollout / testing
No migration, no new edge function. Deploy the dashboard, ship the iOS build, then:
1. Web: Grow → pick a template → create → row appears as **Add content / "Complete payment in the app"** under Needs action.
2. iOS: that card shows **Activate campaign →** → sandbox purchase → becomes *Awaiting budget* → fund it.
3. Contact template: request → HubSpot link opens prefilled; row shows **Requested**; deal appears in HubSpot.
4. Upload a creative and check it in the `campaign-creative` bucket under `{profileId}/{campaignId}.*`.
5. Existing-post template with a connected Page: posts load; an ineligible Instagram post is disabled.
Not compiled/tested here: the iOS change (no Xcode in the cloud session — run `xcodebuild` first) and
the full web create flow against live data.
