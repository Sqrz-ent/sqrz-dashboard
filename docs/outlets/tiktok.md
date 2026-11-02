# TikTok Marketing API outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/tiktok.ts`, `sandbox-tiktok/index.ts`.

Creates campaign → ad group → ad, all `operation_status: DISABLE` (paused). **Two variants of `create_campaign`:** a standard video ad (`asset_id` = a `video_id` from `upload_asset`) and a **Spark Ad** (promotes an existing organic TikTok post: pass `extra.tiktok_item_id`).

## Access & approval
- **What to apply for:** Marketing API access for an app, via **TikTok for Business → Developers** (business-api.tiktok.com, "My Apps").
- **Steps:** (1) have a TikTok For Business account and a **Business Center** (needed for Spark Ads and for managing advertisers); (2) register as a developer and create an app; (3) request the Marketing API scopes you need (ad account management, ad/creative management, reporting) and submit the app for review — approval is manual and can take days to weeks; (4) the advertiser (you) authorizes the approved app via its authorization URL, which returns an `auth_code`; (5) exchange it at `/oauth2/access_token/` for a long-lived **access token**; (6) note the **advertiser id** (Ads Manager / Business Center).
- **For Spark Ads:** the post owner must authorize the post for your ad account (an authorization/post code, or a Business Center link); you then see it as an identity + post (`tiktok_item_id`). Authorizations expire (the creator chooses a period).
- **Needed:** business verification details, a use-case description and a privacy policy URL for app review, a funded or payment-method-attached advertiser account for live delivery. TikTok also offers a sandbox environment in the developer portal — not wired here (unverified; the adapter targets the production host with everything disabled).

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (`openssl rand -hex 32`) and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-tiktok` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-tiktok
export KEY=<SANDBOX_ADMIN_KEY>
```

Body: `{ "action": "ping|upload_asset|create_campaign|insights|pause", "params": {…} }`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

## Secrets
| Secret | What |
|---|---|
| `TIKTOK_ADS_ACCESS_TOKEN` | Long-lived access token from the authorization above (sent as `Access-Token`). |
| `TIKTOK_ADS_ADVERTISER_ID` | The advertiser account id. |
| `TIKTOK_ADS_IDENTITY_ID` | Identity (TikTok account / custom identity) the ads run as. **Required for Spark Ads**, optional otherwise. |
| `TIKTOK_ADS_IDENTITY_TYPE` | Optional, default `AUTH_CODE` (Spark, via authorization code). Others: `BC_AUTH_TT`, `TT_USER`, `CUSTOMIZED_USER` (standard ads use `CUSTOMIZED_USER` automatically). |

## Actions
`upload_asset` takes a **public URL** and TikTok fetches it (`params`: `asset_url`, `title`; image if the URL/`content_type` says so, else video) → `video_id`/`image_id`.

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"create_campaign","params":{"name":"Test artist","slug":"someartist","asset_id":"<video_id>","business_name":"SQRZ","headlines":["Book someartist on SQRZ"],"descriptions":["unused"],"daily_budget_cents":2000,"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

Spark Ad variant — replace `asset_id` with the post:
```json
{"name":"Test artist","slug":"someartist","business_name":"SQRZ","headlines":["Book someartist"],"descriptions":["unused"],"daily_budget_cents":2000,"extra":{"tiktok_item_id":"<post id>"},"validate_only":true}
```

## Verified vs unverified
**Verified** (third-party/search snippets only): Spark Ads = create the ad with `tiktok_item_id` taken from the identity's post list; advertiser id from Ads Manager/Business Center; Business Center onboarding + a long-lived token are required.
**Unverified:** every request/response body (campaign: `objective_type` TRAFFIC, `budget_mode`; ad group: promotion/placement/optimization/billing values; ad: `creatives[]` fields, `identity_type` values), upload-by-URL parameters, the `report/integrated/get` parameters. Responses are `{code, message, data}`; non-zero `code` is treated as an error.

## Known limits
- Daily budget is sent in account-currency units (`cents/100`); TikTok enforces its own minimums per objective.
- Ads are reviewed by TikTok when enabled; Spark Ads also depend on the creator's authorization still being valid.
- No geo/audience targeting is set (add in Ads Manager before enabling).

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes. Variant inputs go in `params.extra` (an object); each outlet documents its keys. The docs sites of all these platforms were unreachable from the build session, so request shapes were written from search snippets of the official docs plus knowledge of the APIs — every file's "Verified vs unverified" list says which is which.
