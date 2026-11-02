# Manual outlets — campaign logging (no API)

Some channels we want to test have **no ads API**: they are booked by hand in a web dashboard. This log lets a Claude Code session (or you) record what was booked and what came back, via curl, next to the API-based outlet sandboxes. **Nothing is sent to any platform** — it is a notebook with structure.

Files: `supabase/migrations/20261103_outlet_sandbox_manual_campaigns.sql` (table `outlet_sandbox.manual_campaigns`), `supabase/functions/sandbox-manual/index.ts`. Same isolation as the other sandboxes: own schema, not exposed via PostgREST, service role only, guarded by `x-sandbox-key`, every call also logged to `outlet_sandbox.outlet_runs` (outlet `manual`).

## Deploy checklist (manual)
1. Apply `20261101_outlet_sandbox.sql` (if not yet) and `20261103_outlet_sandbox_manual_campaigns.sql`. Keep `outlet_sandbox` out of the PostgREST exposed schemas.
2. Set `SANDBOX_ADMIN_KEY` (same secret as the other sandbox functions).
3. Deploy `sandbox-manual` with `--no-verify-jwt`.

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-manual
export KEY=<SANDBOX_ADMIN_KEY>
```

## Manual outlets
Booking URLs and minimums below come from search results of each platform's public pages and third-party write-ups — **confirm in the platform's own flow before budgeting**. Use the lowercase `outlet` token in the first column.

| `outlet` | Platform | Where to book | Minimum budget (as found) | Typical results to log |
|---|---|---|---|---|
| `audiogo` | AudioGO — self-serve audio ads (streaming, podcasts, incl. SoundCloud/Pandora inventory) | audiogo.com — free account, upload creative, pick audience, set budget | **$250** starting budget at a base ~$18 CPM (official site); a separate direct insertion-order path starts at ~$10,000 | `impressions`, `clicks`, `listens`, `completes` |
| `blip` | Blip — self-serve **digital billboards** (blipbillboards.com; not a podcast network) | blipbillboards.com (help: help.blipbillboards.com/get-started-with-blip) | No contract and **no minimum spend** advertised; you set a daily budget | `impressions`, `plays`, `locations` |
| `acast` | Acast — podcast ads marketplace (self-serve for smaller budgets) | acast.com → Advertise / self-serve platform (≈1 business day approval) | **$250** at launch (2022 coverage); one 2026 comparison says "no published minimum" — unclear | `impressions`, `downloads`, `listens` |
| `iheart_adbuilder` | iHeartMedia AdBuilder — self-serve radio/streaming audio ads (not Triton's "AdBuilder AI") | iHeartMedia's advertise pages → AdBuilder (confirm the current URL in-flow) | Varies by market, shown in the flow; **$250** repeated by third parties, unconfirmed | `impressions`, `spots`, `reach` |
| `bandsintown` | Bandsintown — promoted posts / promoted emails (Ad Manager) for artists | artist dashboard at artist.bandsintown.com → Promote / Ad Manager | **$50** promoted posts; **$150** promoted email campaigns (Bandsintown help centre) | `impressions`, `clicks`, `emails_sent`, `rsvps`, `ticket_clicks` |
| `audiomack_sponsored` | Audiomack **Sponsored Songs** — paid placement for tracks | Audiomack Creator Dashboard / Creator App (needs creator verification; public non-premium songs only) | Not on an official page — about **$1** per one guide, **$10** via feature.fm; the flow shows play estimates before you commit | `plays`, `listens`, `followers`, `likes` |
| `soundcloud_promote` | SoundCloud **Promote** — pay to promote a monetized track | SoundCloud for Artists → Promote (Artist Pro plan; earliest start ≈5 days after purchase) | **$25** per promotion (SoundCloud help centre FAQ) | `impressions`, `plays`, `likes`, `follows` |
| `applovin` | AppLovin Ads (formerly Axon Ads Manager) — in-app ads, mostly for app installs | AppLovin Ads / Axon ads manager (company verification + billing; an MMP for app campaigns) | None stated; recommended ≥15–20 conversions/day for stable results | `impressions`, `clicks`, `installs`, `conversions`, `roas` |

Add any other platform by simply using a new lowercase `outlet` token (`a-z`, `0-9`, `_`, 2–40 chars).

## Fields
| Field | Notes |
|---|---|
| `outlet` | Lowercase token (see table). |
| `name` | Campaign name, ≤200 chars. |
| `status` | `planned` (default) · `booked` · `running` · `done` · `cancelled`. Setting `booked` (or creating as booked/running/done) stamps `booked_at` unless you pass it. |
| `booked_at`, `starts_at`, `ends_at` | ISO date/time (`2026-12-01` or full timestamp), `null` clears. `ends_at` must not precede `starts_at`. |
| `budget`, `spend` | Numbers ≥ 0 (2 decimals). `currency`: 3-letter code, default `USD`. |
| `targeting` | Free-form object — audience/geo/genre/placement as the platform words it. |
| `creative_ref` | File name, URL or platform asset id. |
| `landing_url` | Must be `https://<slug>.sqrz.com` (a path is allowed). |
| `results` | Free-form object of whatever the platform reports. **`update` shallow-merges** into it; a `null` value removes that key; pass `"results_mode":"replace"` to overwrite. |
| `notes` | Free text. On `update`, `notes` replaces; **`notes_append`** adds a timestamped line instead (use one or the other). |

## Actions
`create` · `update` (by `id`, any subset of fields) · `list` (filters `outlet`, `status`; `limit` 1–200 default 50, `offset`) · `get` (by `id`). Responses: `{ ok, run_id, action, result }` with `result.campaign` / `result.campaigns` (+ `total`, `count`).

### Log a campaign
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"create",
  "params":{
    "outlet":"audiogo","name":"Someartist — techno night spot","status":"booked",
    "budget":250,"currency":"USD","starts_at":"2026-12-01","ends_at":"2026-12-14",
    "targeting":{"genre":"electronic","geo":"DE","device":"mobile"},
    "creative_ref":"spot_v1.mp3","landing_url":"https://someartist.sqrz.com",
    "notes":"Booked in the AudioGO dashboard, invoice pending"}}'
```
Note the returned `campaign.id` — it is the handle for everything below.

### Mark it running and add first results
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"update",
  "params":{"id":"<campaign id>","status":"running","spend":112.50,
    "results":{"impressions":12000,"clicks":150},
    "notes_append":"day 3 check: pacing fine"}}'
```

### Add more results later (merges; null removes a key)
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"update",
  "params":{"id":"<campaign id>","results":{"listens":900,"conversions":4}}}'
```

### Close it out
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' -d '{
  "action":"update","params":{"id":"<campaign id>","status":"done","spend":250}}'
```

### List / get
```bash
curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"list","params":{"outlet":"audiogo","status":"running"}}'

curl -s $URL -H "x-sandbox-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"get","params":{"id":"<campaign id>"}}'
```

Or straight in SQL (service role / SQL editor): `select outlet, name, status, budget, spend, results from outlet_sandbox.manual_campaigns order by created_at desc;`

## Known limits
- This is a log, not an integration: it never talks to the platforms, and nothing reconciles `spend`/`results` with what the platform shows — enter them from the dashboards.
- Status moves are not enforced (any status can follow any status).
- `results` is untyped by design; keep key names consistent per outlet (see the table) so they can be compared later.
- No delete action: use `status: "cancelled"`.
