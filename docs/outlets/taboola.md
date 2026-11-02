# Taboola Backstage API outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/taboola.ts`, `sandbox-taboola/index.ts`.

Creates a campaign (`is_active: false`) with one campaign item (the sponsored link). Taboola has no ad-group level, so `adGroupId` = the campaign id.

## Access & approval
- **Backstage API access is not self-serve.** Ask your **Taboola account manager** (or Taboola sales/support if you don't have one yet) for **API credentials** — a `client_id` and `client_secret` for the **client-credentials flow**. The old password flow is deprecated.
- **Needed:** an active Taboola advertiser account (accounts normally require a minimum spend commitment / onboarding with Taboola), the account id (Taboola calls it the account / network id), and the permission set for campaign and report access on that account. Tokens last 12 hours.
- Taboola Realize/Backstage has no public sandbox environment; use an unfunded advertiser account and keep everything inactive.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (`openssl rand -hex 32`) and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-taboola` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-taboola
export KEY=<SANDBOX_ADMIN_KEY>
```

Body: `{ "action": "ping|upload_asset|create_campaign|insights|pause", "params": {…} }`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

## Secrets
| Secret | What |
|---|---|
| `TABOOLA_ADS_CLIENT_ID` / `TABOOLA_ADS_CLIENT_SECRET` | From your account manager. |
| `TABOOLA_ADS_ACCOUNT_ID` | The account id used in `/backstage/api/1.0/{account_id}/…` (also returned in the token details). |
| `TABOOLA_ADS_DEFAULT_CPC` | Optional campaign CPC, default `0.10`. |

## Actions
`upload_asset` **uploads nothing**: Taboola fetches thumbnails from a public URL, so it just verifies the URL is a reachable image and returns the URL; pass it as `asset_id` to `create_campaign` (or use `logo_url`).

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"create_campaign","params":{"name":"Test artist","slug":"someartist","asset_id":"https://example.com/thumb.jpg","business_name":"SQRZ","headlines":["Book someartist on SQRZ"],"descriptions":["unused"],"daily_budget_cents":2000,"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

`headlines[0]` → item title (≤100), `business_name` → `branding_text` (≤25). Monthly spending limit is set to 30× the daily cap.

## Verified vs unverified
**Verified** (Taboola Backstage docs, via search snippets): client-credentials flow, 12h token, `Authorization: Bearer`, `account_id` in the path, `GET /backstage/api/1.0/{account_id}/campaigns/`, account id available from the token details. Sources disagree on the token path (`/backstage/oauth/token` vs `/backstage/api/1.0/oauth/token`); the former is used — switch it in `taboola.ts` if you get a 404.
**Unverified:** campaign create fields (`branding_text`, `cpc`, `daily_cap`, `spending_limit(_model)`, `marketing_objective`, `is_active`), item create fields (`url`, `thumbnail_url`, `title`), the report path (`reports/campaign-summary/dimensions/campaign_breakdown`) and fields, the POST partial update used for `pause`.

## Known limits
- Items are reviewed by Taboola's editorial team before they can serve.
- No targeting (country, platform, publisher blocks) is set — configure it in Backstage before activating anything.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes. Variant inputs go in `params.extra` (an object); each outlet documents its keys. The docs sites of all these platforms were unreachable from the build session, so request shapes were written from search snippets of the official docs plus knowledge of the APIs — every file's "Verified vs unverified" list says which is which.
