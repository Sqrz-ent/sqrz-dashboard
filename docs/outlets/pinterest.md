# Pinterest API v5 (ads) outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/pinterest.ts`, `sandbox-pinterest/index.ts`.

Creates campaign → ad group → ad, all `PAUSED`. `PINTEREST_ADS_ENV` = `sandbox` (default, `api-sandbox.pinterest.com`) or `production` (`api.pinterest.com`).

## Access & approval
- **What to apply for:** a Pinterest developer app with **Trial** access, then **Standard** access.
- **Where:** developers.pinterest.com → *My apps* → *Connect app*; you need a **Pinterest Business account** and an ad account.
- **Trial → Standard:** Trial access is granted on app creation and is limited (low rate limits; per third-party guides, production write calls are restricted). **Standard** requires a review (an app description and a demo video of the integration). Pinterest's own sandbox page says sandbox calls for ad accounts/campaigns/ad groups/ads work with Trial or Standard — so you can start in the sandbox right away; third-party sources disagree on whether Trial allows production ad writes, so check your dashboard.
- **Needed:** scopes `ads:read`, `ads:write` (plus `pins:write`/`boards:read` if the adapter must create Pins); for sandbox, create a sandbox ad account and generate the sandbox access token in the portal.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (`openssl rand -hex 32`) and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-pinterest` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-pinterest
export KEY=<SANDBOX_ADMIN_KEY>
```

Body: `{ "action": "ping|upload_asset|create_campaign|insights|pause", "params": {…} }`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

## Secrets
| Secret | What |
|---|---|
| `PINTEREST_ADS_ENV` | `sandbox` (**default**) or `production`. |
| `PINTEREST_ADS_AD_ACCOUNT_ID` | Ad account id (a sandbox ad account in sandbox). |
| `PINTEREST_ADS_ACCESS_TOKEN` | A bearer token (e.g. the sandbox token from the developer portal). **Either this**… |
| `PINTEREST_ADS_APP_ID` / `PINTEREST_ADS_APP_SECRET` / `PINTEREST_ADS_REFRESH_TOKEN` | …**or** these three (refresh-token flow, HTTP Basic at `/oauth/token`). |
| `PINTEREST_ADS_BOARD_ID` | Needed only when `extra.image_url` makes the adapter create a Pin. |
| `PINTEREST_ADS_TARGET_COUNTRY` | Optional, default `US`. |

## Actions
`upload_asset` is **not supported**: Pinterest ads reference **Pins**. Pass an existing `pin_id` as `asset_id`, or `extra.image_url` (+ the board secret) and the adapter creates the Pin first, linking to `https://<slug>.sqrz.com`. In production that Pin is a real organic Pin on the board — use a throwaway board.

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"create_campaign","params":{"name":"Test artist","slug":"someartist","business_name":"SQRZ","headlines":["Book someartist on SQRZ"],"descriptions":["See the profile."],"daily_budget_cents":2000,"extra":{"image_url":"https://example.com/pin.png"},"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

## Verified vs unverified
**Verified** (Pinterest sandbox docs, via search snippets): sandbox host `api-sandbox.pinterest.com`; ad account / campaign / ad group / ad create, list, update and campaign/ad group/ad analytics are available in the sandbox; Trial or Standard access works there.
**Unverified:** request bodies and enums (`objective_type`, `billable_event`, `placement_group`, `targeting_spec`, micro-currency fields), the bulk array body + `{items:[{data,exceptions}]}` response, analytics columns and response, the Pin creation body, the sandbox OAuth path.

## Known limits
- Spend is micro-dollars; budgets are sent as `daily_spend_cap` / `budget_in_micro_currency`.
- Ads need an approved Pin and go through ad review once enabled.
- `pause` uses the bulk `PATCH /campaigns` array form.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes. Variant inputs go in `params.extra` (an object); each outlet documents its keys. The docs sites of all these platforms were unreachable from the build session, so request shapes were written from search snippets of the official docs plus knowledge of the APIs — every file's "Verified vs unverified" list says which is which.
