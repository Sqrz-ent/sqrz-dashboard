# Amazon Ads API outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/amazon.ts`, `sandbox-amazon/index.ts`.

Creates **Sponsored Brands (v4)** campaign → ad group → brand **video** ad, all `PAUSED`, with an **off-Amazon landing page** `https://<slug>.sqrz.com` (`OFF_AMAZON_LINK`) — the only Amazon ad product used here that can send traffic outside Amazon.

## Access & approval
- **Apply as a Direct Advertiser.** On the Amazon Ads API sign-up (advertising.amazon.com/API → *Apply for access*), choose the **Direct advertiser** path (you advertise your own brand), not the Partner/ISV path.
- **No sandbox for this flow.** Every call touches the real account; safety comes from `PAUSED` everywhere and `validate_only`. Use a dedicated account/profile.
- **Steps:** (1) have an **Amazon Ads account** (advertising.amazon.com) with a funded/billing-attached **profile** in the marketplace you advertise in; (2) for Sponsored Brands you also need a **registered brand** (Amazon Brand Registry) → `brandEntityId`, and a brand-logo asset; (3) submit the API access application (company details, use case) and wait for approval email; (4) at developer.amazon.com create a **Login with Amazon security profile** and add the Ads API (`advertising::campaign_management` scope) → **client id / client secret**; (5) authorize the profile through the LWA consent URL to get a **refresh token**; (6) call `GET /v2/profiles` to get the **profileId** (the adapter's `ping` lists them).
- **Regions:** `AMAZON_ADS_REGION` = `na` (advertising-api.amazon.com), `eu` (advertising-api-eu.amazon.com), `fe` (advertising-api-fe.amazon.com). Use the endpoint for the profile's region.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (`openssl rand -hex 32`) and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-amazon` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-amazon
export KEY=<SANDBOX_ADMIN_KEY>
```

Body: `{ "action": "ping|upload_asset|create_campaign|insights|pause", "params": {…} }`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

## Secrets
| Secret | What |
|---|---|
| `AMAZON_ADS_REGION` | `na` (**default**) / `eu` / `fe`. |
| `AMAZON_ADS_CLIENT_ID` / `AMAZON_ADS_CLIENT_SECRET` | LWA security profile. |
| `AMAZON_ADS_REFRESH_TOKEN` | LWA refresh token for the advertiser. |
| `AMAZON_ADS_PROFILE_ID` | Sent as `Amazon-Advertising-API-Scope`. |
| `AMAZON_ADS_BRAND_ENTITY_ID` | Registered brand entity id (Sponsored Brands). Required for `create_campaign`. |
| `AMAZON_ADS_BRAND_LOGO_ASSET_ID` | Brand logo asset id (or pass `extra.brand_logo_asset_id`). |

## Actions
`upload_asset` registers a video/image in the profile's creative assets and PUTs the bytes (≤100MB); use the returned asset id as `asset_id` (video).

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"create_campaign","params":{"name":"Test artist","slug":"someartist","asset_id":"<video asset id>","business_name":"SQRZ","headlines":["Book someartist"],"descriptions":["unused"],"daily_budget_cents":2000,"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

`headlines[0]` → ad headline (≤50), `business_name` → brand name (≤30), `daily_budget_cents ≥ 100`.

## Verified vs unverified
**Verified** (a third-party mirror of the Amazon docs, via search snippets): `POST https://advertising-api.amazon.com/sb/v4/campaigns`, content type `application/vnd.sbcampaignresource.v4+json`, multi-status response, headers `Amazon-Advertising-API-ClientId` + `Amazon-Advertising-API-Scope` (= profileId, from List Profiles), permission `advertiser_campaign_edit`.
**Unverified:** the eu/fe hostnames, every body field and enum (`budget`, `state`, `bidding`, `brandEntityId`, the video ad `creative` + `landingPage`), the other v4 vendor content types, the Creative Assets register/upload calls, the async v3 reporting flow (`/reporting/reports` create → poll → gzip JSON), pause via `PUT /sb/v4/campaigns`.

## Known limits
- No keywords/targeting are set — Sponsored Brands needs them in the console before delivery.
- Sponsored Brands video ads go through Amazon moderation; the off-Amazon landing page must meet Amazon's policies.
- `insights` reporting is asynchronous (the call waits ≤40s); cost is assumed in profile currency.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes. Variant inputs go in `params.extra` (an object); each outlet documents its keys. The docs sites of all these platforms were unreachable from the build session, so request shapes were written from search snippets of the official docs plus knowledge of the APIs — every file's "Verified vs unverified" list says which is which.
