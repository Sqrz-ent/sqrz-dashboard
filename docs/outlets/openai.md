# ChatGPT Ads API outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/openai.ts`, `sandbox-openai/index.ts`.

`https://api.ads.openai.com/v1`, bearer API key. Creates Campaign → Ad Group → Ad (`chat_card` creative), all `paused`.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-openai` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

Base: `POST https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-openai`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`, body `{ "action": …, "params": {…} }`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-openai
export KEY=<SANDBOX_ADMIN_KEY>
```

## Secrets

| Secret | What / how to get it |
|---|---|
| `SANDBOX_ADMIN_KEY` | `openssl rand -hex 32`. |
| `OPENAI_ADS_API_KEY` | Issued in the ChatGPT Ads Manager (a third-party guide says ads.openai.com → Settings → API keys — **confirm in OpenAI's own Ads help**). Needs an approved ChatGPT Ads account. |
| `OPENAI_ADS_TARGET_COUNTRIES` | Optional, comma-separated ISO codes for `targeting.locations.countries` (default `US`). |

No separate sandbox environment is documented: calls are real, objects are `paused`. Use a dedicated, unfunded ad account.

## Actions

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

# upload_asset — image → file_id (optional; used as the card image)
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"upload_asset","params":{"asset_url":"https://example.com/card.png","title":"sandbox card"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"create_campaign",
  "params":{"name":"Test artist","slug":"someartist","asset_id":"<file_id, optional>","business_name":"SQRZ",
    "headlines":["Book someartist on SQRZ"],"descriptions":["See the profile and book directly."],
    "daily_budget_cents":1000,"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

Params: `headlines[0]` → creative `title` (3–50 chars), `descriptions[0]` → `body` (≤100), the slug URL → `target_url`.

## Verified vs unverified
**Verified** (developers.openai.com/ads, via search snippets): base URL and bearer auth; hierarchy; `/v1/ad_groups` with `activate|pause|archive`; direct `POST /v1/campaigns` example (`name`, `status:"paused"`, `bidding_type:"clicks"`, `budget.daily_spend_limit_micros`, `targeting.locations.countries`); `POST /ads` with `status` and `creative {type:"chat_card", title 3–50, body ≤100, target_url, file_id}`; images via `POST /upload`; `GET /v1/ads/{id}/insights` with a granularity parameter. The official docs say `title`/`body` (third-party guides say headline/description — ignored).
**Unverified**: ad-group body (bid-configuration fields — only `campaign_id`, `name`, `status` are sent); `/upload` request format; the list response shape (`data[]`); campaign-level insights path/params/response (read defensively, `spend_micros` preferred); `POST /campaigns/{id}/pause` (confirmed for ad groups only). The Bulk API uses a different, flat budget shape (`max_budget_micros`) — not used here.

## Known limits
- An ad serves only when ad, ad group and campaign are all active **and** the ad has cleared review; updating a creative restarts review.
- ChatGPT Ads availability and countries are limited; confirm for your account.
- Insights are per-campaign calls (≤100 campaigns).

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created paused objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes below.
