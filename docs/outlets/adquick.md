# AdQuick Partner API outlet sandbox (DOOH / billboards)

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/adquick.ts`, `sandbox-adquick/index.ts`.

Out-of-home buying has no campaign/ad-group/ad, so `create_campaign` is mapped to: **plan** (`draft`) → **insertion order** (`draft`) → **creative** attached to it. Mapping in results: `campaignId` = plan id · `adGroupId` = insertion order id · `adId` = creative attachment. Nothing is booked or submitted.

## Access & approval
- **What to apply for:** an **AdQuick partner API token**. It is issued by AdQuick to partners and is account-gated — it cannot be bought or self-generated from a pricing page.
- **Where:** contact AdQuick (adquick.com → partnerships / your AdQuick account rep) and ask for Partner API access for your account; AdQuick's docs live at docs.adquick.com. (AdQuick also offers a hosted MCP server with OAuth 2.0 + PKCE — a separate surface that this adapter does not use.)
- **Needed:** an AdQuick advertiser/partner account, a use-case description (what you will plan and buy, expected volume), and billing set up for real orders. The token is a static secret sent as `X-PARTNER-TOKEN`.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (`openssl rand -hex 32`) and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-adquick` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-adquick
export KEY=<SANDBOX_ADMIN_KEY>
```

Body: `{ "action": "ping|upload_asset|create_campaign|insights|pause", "params": {…} }`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

## Secrets
| Secret | What |
|---|---|
| `ADQUICK_PARTNER_TOKEN` | The partner token from AdQuick (header `X-PARTNER-TOKEN`). |

## Actions
`upload_asset`: image/video creative (≤100MB) multipart-uploaded to the partner creative library → creative id.
`create_campaign` needs `extra.start_date` and `extra.end_date` (`YYYY-MM-DD`, the flight); optional `extra.markets` (array) and `extra.formats` (array). `asset_id` = creative id. Budget = `daily_budget_cents × flight days`. The slug URL is stored as the creative's destination.

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"create_campaign","params":{"name":"Berlin techno night","slug":"someartist","asset_id":"<creative id>","business_name":"SQRZ","headlines":["Someartist live"],"descriptions":["unused"],"daily_budget_cents":5000,"extra":{"start_date":"2026-12-01","end_date":"2026-12-14","markets":["Berlin"]},"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

## Verified vs unverified
**Verified** (third-party profile files, **not** AdQuick's documentation): the partner REST API lives at `https://api.adquick.com`, uses a static `X-PARTNER-TOKEN` header, has no version segment in its paths, and covers creative upload, spec sheets and ordering; access is account-gated.
**Unverified — everything else.** Every path, verb, body and response here (`/plans`, `/plans/{id}/insertion_orders`, `/insertion_orders/{id}/creatives`, `/creatives`, `/plans/{id}/reports`, `PATCH /plans/{id}` for pause) is a plausible REST guess to be corrected against docs.adquick.com. Treat this adapter as a skeleton: `validate_only` shows the intended bodies, and the first real calls will tell you what to change.

## Known limits
- OOH has no real "pause": `pause` sets the plan to `on_hold` (unverified value).
- Reporting is plays/impressions estimates, so `clicks` is always `0` and `videoViews` is `null`.
- Real orders involve inventory availability, creative specs/approvals and lead times set by media owners — none of that is automated here.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes. Variant inputs go in `params.extra` (an object); each outlet documents its keys. The docs sites of all these platforms were unreachable from the build session, so request shapes were written from search snippets of the official docs plus knowledge of the APIs — every file's "Verified vs unverified" list says which is which.
