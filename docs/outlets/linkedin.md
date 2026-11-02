# LinkedIn Advertising API outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/linkedin.ts`, `sandbox-linkedin/index.ts`.

Creates campaign group → campaign → creative, all in LinkedIn's **DRAFT** status, with a **dark post** (an article post with `feedDistribution: NONE`, never shown in any feed) as the creative content.

## Access & approval
- **What to apply for:** the **Advertising API** product on a LinkedIn developer app, starting at the **Development tier**; later the **Standard tier** for production volume.
- **Where:** linkedin.com/developers → *Create app* → link it to a **LinkedIn Company Page** (the page must verify the app) → *Products* tab → request **Advertising API**.
- **Needed:** the Company Page admin to verify the app; a business email/website and a use-case description; for Standard tier an additional application with the intended use, screenshots/video of the integration, and compliance review. The Development tier is limited (a small number of ad accounts, low rate limits, intended for building/testing). Tier limits and exact review steps were not retrievable here — confirm in the developer portal.
- **Tokens:** 3-legged OAuth (scopes `r_ads`, `rw_ads`, `r_ads_reporting`, and `w_organization_social` for posting as the page). A **refresh token** is only issued for approved programmatic-refresh partners; otherwise access tokens (~60 days) must be re-minted by re-authorizing.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (`openssl rand -hex 32`) and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-linkedin` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-linkedin
export KEY=<SANDBOX_ADMIN_KEY>
```

Body: `{ "action": "ping|upload_asset|create_campaign|insights|pause", "params": {…} }`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

## Secrets
| Secret | What |
|---|---|
| `LINKEDIN_ADS_API_VERSION` | `YYYYMM` for the `LinkedIn-Version` header. **Not defaulted** — LinkedIn sunsets versions; pick a current one from the docs (a third-party example used `202601`). |
| `LINKEDIN_ADS_CLIENT_ID` / `LINKEDIN_ADS_CLIENT_SECRET` | The developer app. |
| `LINKEDIN_ADS_REFRESH_TOKEN` | Refresh token (see above). |
| `LINKEDIN_ADS_AD_ACCOUNT_ID` | Numeric ad account id (`urn:li:sponsoredAccount:<id>`). |
| `LINKEDIN_ADS_ORGANIZATION_ID` | Numeric Company Page id; the post author / image owner. |
| `LINKEDIN_ADS_CURRENCY` | Optional, default `USD`. |
| `LINKEDIN_ADS_DEFAULT_CPC` | Optional unit cost, default `5.00`. |
| `LINKEDIN_ADS_LOCATION_URN` | Optional targeting location, default `urn:li:geo:103644278` (unverified id for the United States). |

## Actions
`upload_asset`: PNG/JPEG ≤8MB via the Images API (`initializeUpload` → PUT); the returned image URN can be passed as `asset_id` and becomes the article thumbnail.

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"create_campaign","params":{"name":"Test artist","slug":"someartist","business_name":"SQRZ","headlines":["Book someartist on SQRZ"],"descriptions":["See the profile and book directly."],"daily_budget_cents":2000,"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

`headlines[0]` → article title (≤70), `descriptions[0]` → post commentary (≤255). `daily_budget_cents ≥ 1000`.

## Verified vs unverified
**Verified** (Microsoft Learn LinkedIn docs, via search snippets): versioned `/rest/*` with `LinkedIn-Version: YYYYMM` + `X-Restli-Protocol-Version: 2.0.0`; `POST /rest/adAccounts/{id}/adCampaignGroups`; `POST /rest/adCampaigns`; status `DRAFT` → `ACTIVE` activation; creatives under `/adAccounts/{id}/creatives` referencing a campaign and a content URN; account limits (5,000 campaigns per account).
**Unverified:** campaign fields (type `SPONSORED_UPDATES`, objective `WEBSITE_VISIT`, `targetingCriteria`, `unitCost`, `dailyBudget`), the Posts API dark-post body, the Images flow, `adAnalytics` query/response, `PARTIAL_UPDATE` pause, and that creation responses return the new id in the `x-restli-id` header (the adapter fails clearly if it doesn't).

## Known limits
- Dark posts are real posts on the Company Page's account (just never distributed); delete them in Campaign Manager if unused.
- A campaign in DRAFT cannot be "paused" — `pause` is for ACTIVE campaigns.
- `insights` returns empty `campaignName`s (no extra lookup).

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes. Variant inputs go in `params.extra` (an object); each outlet documents its keys. The docs sites of all these platforms were unreachable from the build session, so request shapes were written from search snippets of the official docs plus knowledge of the APIs — every file's "Verified vs unverified" list says which is which.
