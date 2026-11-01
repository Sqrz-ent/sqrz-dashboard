# Google outlet sandbox (Google Ads + YouTube)

Isolated sandbox for the future Google ad outlet. **Not connected to the live app**: no iOS changes, no triggers/cron, no existing tables or functions touched. It only writes to the `outlet_sandbox` schema and to Google.

| Piece | Path |
|---|---|
| Migration (not applied) | `supabase/migrations/20261101_outlet_sandbox.sql` |
| Adapter interface | `supabase/functions/_shared/outlets/types.ts` |
| Auth guard | `supabase/functions/_shared/outlets/sandbox-guard.ts` |
| Run/object logging | `supabase/functions/_shared/outlets/sandbox-db.ts` |
| Google adapter | `supabase/functions/_shared/outlets/google.ts` |
| Edge function | `supabase/functions/sandbox-google-ads/index.ts` |

## Deploy checklist (manual)

1. Apply the migration. **Do not** add `outlet_sandbox` to *Settings → API → Exposed schemas*; the function reaches it through `SUPABASE_DB_URL`.
2. Set the secrets below (`supabase secrets set …`).
3. Deploy `sandbox-google-ads` with `--no-verify-jwt` (custom auth via `x-sandbox-key`, like the `meta-*` functions).

## Required secrets

| Secret | What / how to get it |
|---|---|
| `SANDBOX_ADMIN_KEY` | Any long random string (`openssl rand -hex 32`). Sent as `x-sandbox-key`. Unset = every request is 401. |
| `GOOGLE_ADS_API_VERSION` | e.g. `v25`. **Not defaulted in code on purpose**: check Google's [release notes](https://developers.google.com/google-ads/api/docs/release-notes) and [sunset dates](https://developers.google.com/google-ads/api/docs/sunset-dates) and pick the newest major. (The build session could not reach those pages; secondary sources suggested v25, with v26 possibly out — verify.) Google sunsets majors roughly one year after release. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads **manager (MCC)** account → Tools → *API Center*. A new token has *Test* access (only works on test accounts). Apply for *Basic* access to touch real accounts. |
| `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` | Google Cloud Console → *APIs & Services → Credentials* → OAuth client ID. Enable **Google Ads API** and **YouTube Data API v3** on that project. Configure the OAuth consent screen (add yourself as test user, or publish; "Testing" status refresh tokens expire after 7 days). |
| `GOOGLE_ADS_REFRESH_TOKEN` | Run the OAuth consent once, e.g. in the [OAuth Playground](https://developers.google.com/oauthplayground) (⚙ → "Use your own OAuth credentials", enter client id/secret, access type *offline*). **Authorize both scopes in one go**: `https://www.googleapis.com/auth/adwords` and `https://www.googleapis.com/auth/youtube.upload` (add `https://www.googleapis.com/auth/youtube.readonly` if you want the channel check in `ping` to pass). Sign in as the Google user who has access to the ad account **and** owns the YouTube channel the videos should land on. Exchange the code and copy the refresh token. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | The manager (MCC) account id used to access the client account, digits only (dashes are stripped). Sent as `login-customer-id`. |
| `GOOGLE_ADS_CUSTOMER_ID` | The client account id the sandbox operates on. Strongly recommended: a Google Ads **test account** created under the MCC. |

Plus the auto-injected `SUPABASE_DB_URL`.

## Actions

Base: `POST https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-google-ads` with headers `x-sandbox-key: $KEY` and `Content-Type: application/json`. Body `{ "action": …, "params": {…} }`. Every response includes a `run_id` pointing at `outlet_sandbox.outlet_runs`.

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-google-ads
export KEY=<SANDBOX_ADMIN_KEY>
```

### ping — OAuth + Ads account + YouTube scope check (read-only)
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"ping"}'
```

### upload_video — YouTube resumable upload from a URL
Streams the file from `video_url` (must be https and send `Content-Length`). Default privacy is `unlisted` (ads can't use `private`). The video id is logged as `youtube_video` in `outlet_objects`.
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"upload_video",
  "params":{"video_url":"https://example.com/spot.mp4","title":"SQRZ sandbox spot","description":"test","privacy":"unlisted"}
}'
```

### create_demand_gen — Demand Gen campaign, budget, ad group, video ad (always PAUSED)
Final URL is `https://<slug>.sqrz.com`. `daily_budget_cents` is in the account currency. Optional `geo` (`latitude`, `longitude`, `radius_km`), `cta` (default `LEARN_MORE`).
**Run with `validate_only: true` first** — Google validates the whole request and creates nothing.
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"create_demand_gen",
  "params":{
    "name":"Test artist",
    "slug":"someartist",
    "video_id":"dQw4w9WgXcQ",
    "logo_url":"https://example.com/logo-square.png",
    "business_name":"SQRZ",
    "headlines":["Book me on SQRZ"],
    "long_headlines":["See my profile and book me directly on SQRZ"],
    "descriptions":["Real artists. Real bookings."],
    "daily_budget_cents":1000,
    "validate_only":true
  }
}'
```
Drop `validate_only` to create for real (still PAUSED). Ids of budget, campaign, ad group, ad and assets are logged to `outlet_objects`.

### insights — spend, impressions, clicks, video views (Demand Gen **and** existing VIDEO campaigns)
`date_preset`: `TODAY, YESTERDAY, LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS (default), THIS_MONTH, LAST_MONTH, ALL_TIME`, or `from`/`to` (`YYYY-MM-DD`). Optional `campaign_ids`.
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"insights","params":{"date_preset":"LAST_30_DAYS"}}'
```

### pause
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"pause","params":{"campaign_id":"1234567890"}}'
```

### Inspecting the log
```sql
select created_at, action, status, error from outlet_sandbox.outlet_runs order by created_at desc limit 20;
select * from outlet_sandbox.outlet_objects order by created_at desc;
```

## Known limits and caveats

- **Video campaigns can't be created via the API.** Classic `VIDEO` campaigns are reporting-only; use Demand Gen for YouTube inventory. `insights` includes existing VIDEO campaigns but nothing here creates or edits one.
- **Everything is created PAUSED** and there is no code path that enables anything. Enabling is a manual step in the Google Ads UI.
- **Payload shapes are unverified.** The build session had no access to Google's docs, so field names (`demandGenVideoResponsiveAd`, `callToActions`, `targetSpend`, `containsEuPoliticalAdvertising`, the video metric) are from knowledge of the API, not checked against the reference for your pinned version. Use `validate_only`; expect to adjust once. Ad-group `type` and Demand Gen channel controls are intentionally left at defaults.
- **Developer token level**: Test access works only on test accounts. Basic access requires Google's review. Standard/Basic have daily operation quotas.
- **YouTube Data API**: `videos.insert` costs 1,600 quota units; the default quota is 10,000/day (~6 uploads). Videos uploaded through an API project that hasn't passed Google's compliance audit are locked to `private` — unusable in ads. Check `visibility` in the upload result.
- **Upload size/time**: the file is streamed through the edge function, not buffered, but is bound by the function wall-clock limit (150 s free / 400 s paid). Large videos may time out. Streaming PUT with an explicit `Content-Length` has not been exercised against YouTube from a Supabase runtime yet.
- **Refresh token scopes**: one refresh token must carry both `adwords` and `youtube.upload`; `ping` reports missing scopes. A consent screen in *Testing* status expires refresh tokens after 7 days.
- **Demand Gen requirements**: a square logo image, at least one headline/long headline/description (limits 30/90/90 chars, business name 25), a public or unlisted YouTube video. Google reviews ads on enabling.
- **Duplicates**: an existing YouTube video asset for the same video id is reused; image assets are deduplicated by Google.
- **Insights**: money comes back in micros and is converted to major units; `cost` is per account currency. If the video-views metric is incompatible with a campaign type the query is retried without it and a note is returned.
- **Atomicity**: campaign creation is a single `googleAds:mutate` call (all-or-nothing), so unlike the Meta chain there is nothing to roll back on failure.
- **Logging**: if `outlet_runs` can't be written (migration not applied) the function refuses to call Google.
