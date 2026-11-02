# Reddit Ads API outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/reddit.ts`, `sandbox-reddit/index.ts`.

Creates campaign → ad group (with **community / subreddit targeting**) → ad, all `configured_status: PAUSED`.

## Access & approval
- **What to apply for:** access to the **Reddit Ads API** (v3). It is **allow-listed**: an ordinary Reddit developer app is not enough.
- **Where / how:** apply through Reddit Ads (ads.reddit.com → your Business/ad account, and Reddit's Ads API access request / your Reddit Ads rep). You need an active Reddit Ads account with an ad account id (starts `a2_…`). Separately create an OAuth app at reddit.com/prefs/apps (type *web app* or *script*; you get a client id and secret) and have that app allow-listed for the Ads API.
- **Needed:** the Reddit user that owns/administers the ad account authorizes the app (authorization-code flow with `duration=permanent`, scopes for ads read/write) to produce a **refresh token**; Reddit must approve your use case; billing set up for live delivery. Exact application channel/terms were not retrievable here — confirm with Reddit Ads.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (`openssl rand -hex 32`) and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-reddit` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-reddit
export KEY=<SANDBOX_ADMIN_KEY>
```

Body: `{ "action": "ping|upload_asset|create_campaign|insights|pause", "params": {…} }`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

## Secrets
| Secret | What |
|---|---|
| `REDDIT_ADS_CLIENT_ID` / `REDDIT_ADS_CLIENT_SECRET` | The allow-listed OAuth app (HTTP Basic at the token endpoint). |
| `REDDIT_ADS_REFRESH_TOKEN` | Permanent refresh token for the ad-account user. |
| `REDDIT_ADS_ACCOUNT_ID` | Ad account id (`a2_…`), used in `/accounts/{id}/…`. |
| `REDDIT_ADS_USER_AGENT` | Optional descriptive User-Agent (Reddit rejects generic ones). |
| `REDDIT_ADS_PROFILE_ID` | Optional Reddit profile the ad posts as, if your account requires one. |

## Actions
`upload_asset` is **not supported** (no verified upload endpoint): pass a hosted https image as `logo_url`, `asset_id` (URL) or `extra.image_url` to `create_campaign`.
**Community targeting:** `extra.communities` = array of subreddit names (`"r/techno"`, `"Berlin"`) and/or community ids (`t5_…`). Names are resolved to ids through `reddit.com/r/<name>/about.json`; with `validate_only` nothing is resolved.

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"create_campaign","params":{"name":"Test artist","slug":"someartist","logo_url":"https://example.com/creative.png","business_name":"SQRZ","headlines":["Book someartist on SQRZ"],"descriptions":["unused"],"daily_budget_cents":2000,"extra":{"communities":["r/techno","Berlin"]},"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

## Verified vs unverified
**Verified** (third-party guides, not Reddit's reference): base `https://ads-api.reddit.com/api/v3`; `POST /accounts/{account_id}/ad_groups`; ads default to PAUSED on create; DAILY_SPEND ad groups have a $5/day minimum (enforced here: `daily_budget_cents ≥ 500`); targeting uses community **ids**, not names.
**Unverified:** campaign/ad group/ad bodies and enum values (`objective`, `bid_strategy`, `goal_type`/`goal_value` in micros), the creative shape, the reports endpoint (`POST /accounts/{id}/reports`) and its response, names→ids via `about.json` (`name` = `t5_…`), pause via `PATCH`.

## Known limits
- Reddit ads need approval/review when enabled; some objectives require a pixel or a profile.
- Insights assume micro-unit spend.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes. Variant inputs go in `params.extra` (an object); each outlet documents its keys. The docs sites of all these platforms were unreachable from the build session, so request shapes were written from search snippets of the official docs plus knowledge of the APIs — every file's "Verified vs unverified" list says which is which.
