# Snapchat Marketing API outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/snapchat.ts`, `sandbox-snapchat/index.ts`.

Creates Campaign → Ad Squad → **WEB_VIEW** Creative → Ad, all `PAUSED`, opening `https://<slug>.sqrz.com` from a video/image snap. Media is a placeholder created first, then the file is uploaded.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-snapchat` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

Base: `POST https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-snapchat`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`, body `{ "action": …, "params": {…} }`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-snapchat
export KEY=<SANDBOX_ADMIN_KEY>
```

## Secrets

| Secret | What / how to get it |
|---|---|
| `SANDBOX_ADMIN_KEY` | `openssl rand -hex 32`. |
| `SNAPCHAT_ADS_CLIENT_ID` / `SNAPCHAT_ADS_CLIENT_SECRET` | Snap Business Manager → Business Details → OAuth Apps → create app (redirect URI of your choice). |
| `SNAPCHAT_ADS_REFRESH_TOKEN` | Authorize at `accounts.snapchat.com/login/oauth2/authorize` with scope `snapchat-marketing-api`, `response_type=code`; exchange the code at `…/login/oauth2/access_token`. Snap does not rotate refresh tokens. |
| `SNAPCHAT_ADS_AD_ACCOUNT_ID` | Ad account id from Business Manager / Ads Manager. Use a dedicated, unfunded account. |
| `SNAPCHAT_ADS_PROFILE_ID` | Optional. Public Profile id, added as `profile_properties` on the creative if your account requires one. |
| `SNAPCHAT_ADS_OBJECTIVE` | Optional campaign objective (default `WEB_CONVERSION` is an **unverified guess** — set the right value). |
| `SNAPCHAT_ADS_TARGET_COUNTRY` | Optional 2-letter country for ad-squad targeting (default `us`). |

There is no known separate Snapchat sandbox environment: all calls hit the real API, but everything is created `PAUSED`.

## Actions

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

# upload_asset — video or image, ≤32MB; returns the media id
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"upload_asset","params":{"asset_url":"https://example.com/spot.mp4","title":"sandbox spot"}}'

# create_campaign — needs asset_id from upload_asset; media must be READY
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"create_campaign",
  "params":{"name":"Test artist","slug":"someartist","asset_id":"<media id>","business_name":"SQRZ",
    "headlines":["Book me on SQRZ"],"descriptions":["unused by Snapchat"],"daily_budget_cents":1000,"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

Params: one `headline` ≤34 chars, `business_name` (brand name) ≤25, `daily_budget_cents` ≥ 500 (Snap minimum 5,000,000 micro). `descriptions` are required by the shared handler but unused. `cta` is passed as `call_to_action` if given.

## Verified vs unverified
**Verified** (Snap docs, via search snippets): base `https://adsapi.snapchat.com/v1`; hierarchy; OAuth refresh (`accounts.snapchat.com`, `grant_type=refresh_token`, scope `snapchat-marketing-api`, ~1h access token); `POST /campaigns/{id}/adsquads` body fields (`type SNAP_ADS`, `billing_event`, `bid_strategy`, `daily_budget_micro` min 5,000,000, `delivery_constraint`, `targeting.geos`, `start_time`, `optimization_goal` incl. `SWIPES`).
**Unverified**: campaign `objective`; creative (`WEB_VIEW`, field names/limits) and ad (`REMOTE_WEBPAGE`) bodies; media create/upload paths and the 32MB cap (bigger files need Snap's chunked upload, not implemented); stats response shape and time-window alignment; pause via full-object `PUT` (read-modify-write, read-only fields stripped).

## Known limits
- Bulk-style responses return HTTP 200 with a per-item `sub_request_status`; the adapter treats anything other than `SUCCESS` as a failure.
- Media processing is asynchronous — `create_campaign` fails with a "not READY yet" message until it is; retry.
- `clicks` = swipes. Spend is micro-currency, converted to major units.
- Ads still go through Snap's review once enabled.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created paused objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes below.
