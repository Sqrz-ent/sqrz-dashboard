# Microsoft Advertising (Bing Ads) outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/microsoft.ts`, `sandbox-microsoft/index.ts` (shared: `sandbox-common.ts`, `sandbox-handler.ts`).

Creates a **Search** campaign → ad group → **Responsive Search Ad**, all `Paused`, via the Campaign Management v13 **REST/JSON** endpoints (not SOAP). No keywords or geo targeting are set — add them in the UI before ever enabling.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-microsoft` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

Base: `POST https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-microsoft`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`, body `{ "action": …, "params": {…} }`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-microsoft
export KEY=<SANDBOX_ADMIN_KEY>
```

## Secrets

| Secret | What / how to get it |
|---|---|
| `SANDBOX_ADMIN_KEY` | `openssl rand -hex 32`. Sent as `x-sandbox-key`. |
| `MICROSOFT_ADS_ENV` | `sandbox` (**default if unset**) or `production`. Production only when set explicitly. |
| `MICROSOFT_ADS_DEVELOPER_TOKEN` | Microsoft Advertising → Tools → Developer Portal. **Optional in sandbox**: falls back to Microsoft's published universal sandbox token (`BBD37VB98`). Required for production. |
| `MICROSOFT_ADS_CLIENT_ID` | Azure AD (Entra) app registration, "Accounts in any org + personal Microsoft accounts". |
| `MICROSOFT_ADS_CLIENT_SECRET` | Optional — only for a confidential-client app registration; omit for a public/native client. |
| `MICROSOFT_ADS_REFRESH_TOKEN` | Run the OAuth consent once (scope `https://ads.microsoft.com/msads.manage offline_access`) as a user of the Microsoft Advertising (sandbox) account; exchange the code for a refresh token. |
| `MICROSOFT_ADS_CUSTOMER_ID` | Sent as `CustomerId`. Shown in the account's URL / Account settings (sandbox: from the sandbox account you created). |
| `MICROSOFT_ADS_ACCOUNT_ID` | Sent as `CustomerAccountId` and in request bodies. |
| `MICROSOFT_ADS_DEFAULT_CPC` | Optional ad-group CPC bid in account currency (default `0.5`). |

Sandbox: create a sandbox user/account at the Microsoft Advertising sandbox sign-in, then use its customer/account ids. Sandbox calls use the same OAuth flow, with the sandbox hosts (`campaign.api.sandbox.bingads.microsoft.com`, `reporting.api.sandbox.bingads.microsoft.com`).

## Actions

```bash
# ping — lists Search campaigns for the account (read-only)
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

# create_campaign — dry run first
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"create_campaign",
  "params":{"name":"Test artist","slug":"someartist","business_name":"SQRZ",
    "headlines":["Book me on SQRZ","Real artists","Direct bookings"],
    "descriptions":["See my profile and book directly.","Real artists. Real bookings."],
    "daily_budget_cents":1000,"validate_only":true}}'

# insights — Reporting service; submits a report, polls ≤40s, downloads the zipped CSV
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

# pause
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"123456789"}}'

# upload_asset — PNG/JPEG into the account media library (only needed for Audience/Multimedia ads)
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"upload_asset","params":{"asset_url":"https://example.com/img.png","title":"sandbox image"}}'
```

Params: `headlines` 3–15 × ≤30 chars, `descriptions` 2–4 × ≤90 chars (RSA limits); `asset_id`, `logo_url`, `long_headlines`, `cta` are ignored for Search ads.

## Verified vs unverified
**Verified** (Microsoft docs, via search snippets — the docs host itself was unreachable from the build session): REST base hosts; `POST /CampaignManagement/v13/Campaigns` with `{AccountId, Campaigns[]}`; `POST /Campaigns/QueryByAccountId` with `{AccountId, CampaignType}`; headers `DeveloperToken`, `CustomerId`, `CustomerAccountId` + bearer; performance data only via the Reporting service (CSV); universal sandbox developer token.
**Unverified** (from the SOAP object model): AdGroups / Ads / Media paths and the HTTP verb for updates (`PUT /Campaigns`); AdGroup and ResponsiveSearchAd field names; Reporting REST paths (`/GenerateReport/Submit|Poll`), request/poll shape and the zipped CSV; the OAuth scope string. Expect to adjust once; use `validate_only` to review bodies.

## Known limits
- Microsoft **rotates refresh tokens**; the response's new token is not persisted (no secret writes). The original normally stays valid until its own expiry, but re-mint it if `OAuth refresh` starts failing.
- Search ads have no video views → `videoViews` is `null`. Reports can take longer than 40s; the call then returns `rows: []` with a note — retry.
- RSA review applies when enabled; sandbox accounts don't run real review/delivery.
- Developer-token level: production needs an approved token; the universal sandbox token only works against sandbox hosts.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created paused objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes below.
