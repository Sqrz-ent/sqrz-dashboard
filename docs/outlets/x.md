# X (Twitter) Ads API outlet sandbox

Isolated sandbox connector. Not connected to the live app. Files: `_shared/outlets/x.ts`, `sandbox-x/index.ts`.

Creates campaign → line item (`PROMOTED_TWEETS`) → promoted tweet, all `entity_status: PAUSED`. The creative is a Tweet: by default a **nullcast** tweet (promoted-only, not on the timeline) `"<headline> https://<slug>.sqrz.com"`; or promote an existing tweet with `extra.tweet_id`.

## Access & approval
- **What to apply for:** **X Ads API access** — it is not part of the normal X API tiers; it needs a separate approval and the ad account must be linked to your developer app.
- **Where:** the Ads API application on developer.x.com (the "Apply for Ads API access" form linked from the Ads API docs), after creating a developer account and a project/app.
- **Needed:** the app's **consumer key** is allow-listed for the Ads API once approved; you need an **X Ads account** (ads.x.com) with a **funding instrument** (payment method); the OAuth 1.0a **access token + secret** must belong to a user with Ad Manager / Account Admin permission on that ad account (generate them in the app's *Keys and tokens*, or via 3-legged OAuth). Approval criteria and turnaround were not retrievable here — expect a manual review with a use-case description.
- **Auth style:** OAuth **1.0a** HMAC-SHA1 request signing (not OAuth 2.0 bearer). The signer is tested against Twitter's published signature example.

## Deploy checklist (manual)

1. Apply `supabase/migrations/20261101_outlet_sandbox.sql` (shared sandbox schema; already in the repo). Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (`openssl rand -hex 32`) and the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-x` with `--no-verify-jwt` (custom auth via `x-sandbox-key`).

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-x
export KEY=<SANDBOX_ADMIN_KEY>
```

Body: `{ "action": "ping|upload_asset|create_campaign|insights|pause", "params": {…} }`, headers `x-sandbox-key: $KEY` + `Content-Type: application/json`. Every response carries a `run_id` into `outlet_sandbox.outlet_runs`; created ids land in `outlet_sandbox.outlet_objects`.

## Secrets
| Secret | What |
|---|---|
| `X_ADS_ENV` | `sandbox` (**default**, `ads-api-sandbox.twitter.com`) or `production` (`ads-api.x.com`). The sandbox host is unverified. |
| `X_ADS_API_VERSION` | Optional, default `12` (the version shown in the current line-items reference); override when X moves on. |
| `X_ADS_CONSUMER_KEY` / `X_ADS_CONSUMER_SECRET` | The allow-listed app. |
| `X_ADS_ACCESS_TOKEN` / `X_ADS_ACCESS_TOKEN_SECRET` | User-context OAuth 1.0a credentials. |
| `X_ADS_ACCOUNT_ID` | The ads account id (the short alphanumeric id, e.g. `18ce54…`). |
| `X_ADS_FUNDING_INSTRUMENT_ID` | From `GET accounts/:id/funding_instruments`. Required to create a campaign. |
| `X_ADS_AS_USER_ID` | Optional: the user id the nullcast tweet is posted as. |

## Actions
`upload_asset` is **not supported** — X creatives are Tweets. Create the tweet (with media) in X and pass `extra.tweet_id`, or let the adapter create a text + link nullcast tweet.

```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"ping"}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{"action":"create_campaign","params":{"name":"Test artist","slug":"someartist","business_name":"SQRZ","headlines":["Book someartist on SQRZ"],"descriptions":["unused"],"daily_budget_cents":2000,"validate_only":true}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"<campaign id>"}}'
```

## Verified vs unverified
**Verified** (X docs, via search snippets): the flow funding instrument → campaign (`funding_instrument_id`, `name`, budget fields) → line item (`campaign_id`, `product_type: PROMOTED_TWEETS`, `entity_status: PAUSED`) → promoted tweets; allowed product types; limits (100 line items per campaign, 256 active overall); un-pausing is a PUT with `entity_status`; OAuth 1.0a.
**Unverified:** line-item `objective` / `placements` / `bid_type`, the nullcast tweet endpoint (`POST accounts/:id/tweet`), the sandbox host, the stats response shape (`id_data[].metrics`, arrays of values), campaign `daily_budget_amount_local_micro` semantics.

## Known limits
- The nullcast tweet is created for real on the account (never on the timeline); the Ads API requires the tweet to exist before it can be promoted.
- `insights`: stats windows are hour-aligned UTC; `end_time` is `to + 1 day`.
- Requests are form-encoded; arrays are comma-joined.

**Rules for every outlet:** everything created is paused/draft (no code path enables anything); the final URL is always `https://<slug>.sqrz.com` (`slug` must be `a-z0-9-`); `geo` is rejected (not supported by the sandbox adapters yet); on a mid-chain failure nothing is deleted — the already-created objects are logged in `outlet_objects` for manual cleanup. **`validate_only: true` on `create_campaign` sends nothing to the outlet** and returns the exact request bodies the adapter would send — use it first, and to review the unverified shapes. Variant inputs go in `params.extra` (an object); each outlet documents its keys. The docs sites of all these platforms were unreachable from the build session, so request shapes were written from search snippets of the official docs plus knowledge of the APIs — every file's "Verified vs unverified" list says which is which.
