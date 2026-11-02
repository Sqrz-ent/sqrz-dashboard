# Spotify Ads API (v3) outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/spotify.ts`, `sandbox-spotify/index.ts`.

Creates **drafts** — draft campaign → draft ad set → draft ad (audio or video primary asset, optional companion image) — under the ad account. Drafts never deliver, and nothing here submits or publishes them.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-spotify` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

Base: `POST https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-spotify`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`, body `{ "action": …, "params": {…} }`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-spotify
export KEY=<SANDBOX_ADMIN_KEY>
```

## Secrets

| Secret | What / how to get it |
|---|---|
| `SANDBOX_ADMIN_KEY` | `openssl rand -hex 32`. |
| `SPOTIFY_ADS_ENV` | `sandbox` (**default if unset**, `…/ads-sandbox/v3`) or `production` (`…/ads/v3`). |
| `SPOTIFY_ADS_CLIENT_ID` / `SPOTIFY_ADS_CLIENT_SECRET` | Spotify Ads API application (request access via Spotify Ads Manager / the Ads API developer docs). |
| `SPOTIFY_ADS_REFRESH_TOKEN` | Run the authorization-code flow once for the ad-account user; keep the refresh token. The adapter exchanges it at `accounts.spotify.com/api/token` with HTTP Basic client auth (**unverified for the Ads API** — check the "Using the refresh token" quickstart section). |
| `SPOTIFY_ADS_AD_ACCOUNT_ID` | Ad account id from Ads Manager. |
| `SPOTIFY_ADS_TARGET_COUNTRY` | Optional 2-letter country for ad-set targets (default `US`). |

## Actions

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

# upload_asset — audio/video/image ≤50MB: create asset, then multipart upload
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"upload_asset","params":{"asset_url":"https://example.com/spot.mp3","title":"sandbox spot"}}'

# create_campaign — asset_id must be an AUDIO or VIDEO asset; logo_url (optional) becomes the companion image
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"create_campaign",
  "params":{"name":"Test artist","slug":"someartist","asset_id":"<asset id>","business_name":"SQRZ",
    "headlines":["Book someartist"],"descriptions":["unused"],"daily_budget_cents":1000,
    "logo_url":"https://example.com/cover.png","validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

Params: `headlines[0]` → `tagline` (≤40 here, limit unverified), `business_name` → `advertiser_name` (≤25), `cta` → `cta_text`.

## Verified vs unverified
**Verified** (Spotify docs / spotify/ads-agentic-tools, via search snippets): both base URLs; draft-first flow (`drafts/campaigns` → `drafts/ad_sets` → `drafts/ads` under the ad account); optional `Idempotency-Key` on POSTs; `objective` is deprecated on campaign create; ad-set fields `campaign_id`, `name`, `asset_format` (AUDIO|VIDEO|IMAGE|CATALOG), `delivery` ON/OFF, `targets` (required), `start_time` (≥15 min ahead); assets are created, then `…/upload` as multipart, then checked with GET; micro-unit amounts.
**Unverified**: the OAuth token endpoint/auth style; the `targets` and `budget` object shapes; the ad body (`asset_id`, `companion_asset_id`, `landing_page_url`, `tagline`, `advertiser_name`, `cta_text`); exact asset paths and size cap; the reporting endpoint (`aggregate_reports`, modeled on v2) and response; how a published entity is paused (`PATCH …/ad_sets/{id} {"delivery":"OFF"}` on the campaign's ad sets).

## Known limits
- Drafts can't be paused (they never deliver); `pause` only acts on published ad sets and errors clearly if there are none. Publishing/submitting for review is deliberately not implemented.
- Larger assets need Spotify's chunked upload — not implemented (50MB cap).
- Audio/video ads have no click-only objective here; `videoViews` is always `null`.
- Insights are empty for drafts.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created paused objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes below.
