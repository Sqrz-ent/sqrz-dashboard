# Outlet sandbox admin (iOS sheet backend)

> ## ⚠️ Access = `accounts.is_lab`
> **Anyone with `is_lab` can see setup status and replace API keys.**
> **Before adding external Lab testers, switch this check to a dedicated admin flag.**
> (`is_lab` also unlocks the non-Meta campaign templates for testers — the two should not stay coupled once outside testers exist. The check lives in one place: `authorize()` in `supabase/functions/sandbox-admin/index.ts`.)

Backend for the "sandbox sheet" in the iOS app, so the whole outlet setup can be done from a phone: see each outlet's setup status and checklist, paste API keys, run a connection test. Not connected to the live app's features.

| Piece | Path |
|---|---|
| Migration (not applied) | `supabase/migrations/20261105_outlet_sandbox_admin.sql` |
| Edge function | `supabase/functions/sandbox-admin/index.ts` |
| Secret helper (Vault → env) | `supabase/functions/_shared/outlets/outlet-secrets.ts` |
| Adapter registry (for `test_connection`) | `supabase/functions/_shared/outlets/registry.ts` |

## How it works
```
iOS sheet ──(user JWT)──► sandbox-admin ──► checks caller_account_is_lab() with the caller's own JWT ──► 403 if not lab
                               │ direct Postgres connection (like every sandbox function)
                               ▼
        outlet_sandbox.outlets (status, checklist, notes, secret NAMES)
        outlet_sandbox.*_outlet_secret(s) functions ──► Vault  (outlet_<NAME>)
                               ▲
every sandbox-<outlet> request ┘  primes that outlet's Vault values, then reads config: Vault first, function secrets second
```
- **`outlet_sandbox.outlets`** — one row per outlet (13 API connectors + 8 manual outlets, seeded from `docs/outlets/<outlet>.md`): `display_name`, `kind` (`api`/`manual`), `status`, ordered `checklist` (`[{key,label,done}]`), `required_secrets` and `optional_secrets` (secret **names** only), `docs_path`, `notes`, `updated_at`. (`optional_secrets` is an addition to the spec'd columns: the `*_ENV`, `*_TARGET_COUNTRY`… settings the adapters read but can default — they need to be settable from the phone too.) Same access rules as the other `outlet_sandbox` tables: not exposed via PostgREST, RLS on with no policies, service role only.
- **Status** — `not_started` → `account_created` → `applied` → `approved` → `keys_set` → `connected`. You set the first four by hand (`update_outlet`). `keys_set` is automatic: setting a secret bumps to `keys_set` once **all required** secrets are present, and deleting one demotes `keys_set`/`connected` back to `approved`. A **successful** `test_connection` sets `connected`; a failed test never changes the status.
- **Seeding** is `ON CONFLICT DO NOTHING` — re-running the migration never overwrites progress, notes or edited checklists.

## Secrets (Vault)
- Stored in `vault.secrets` as **`outlet_<NAME>`** (e.g. `outlet_TIKTOK_ADS_ACCESS_TOKEN`), written only through `outlet_sandbox.set_outlet_secret` / `delete_outlet_secret`, `SECURITY DEFINER`, executable by **service role only**, and **restricted to names listed in some outlet's `required_secrets` / `optional_secrets`** (so the sheet can't be used to write arbitrary Vault entries or touch other secrets). The functions live in `outlet_sandbox` and are called over the direct Postgres connection that every sandbox function already uses — they are deliberately *not* added to the public/PostgREST API (unlike `public.get_meta_sync_secret`).
- **Read order for every adapter: Vault first, then function secrets (`supabase secrets set …`).** All adapters load config through `getOutletSecret()` (via `requireEnv`/`optionalEnv` in `sandbox-common.ts`; `google.ts`'s config function uses it directly). Each `sandbox-<outlet>` request first *primes* that outlet's Vault values (one query), so a key pasted in the sheet is used by the very next request, no redeploy. Deleting a Vault value falls back to the function secret again. If the Vault read fails (e.g. migration not applied yet) it logs a warning and uses function secrets only — existing setups keep working.
- `SANDBOX_ADMIN_KEY` (the curl key for the other sandbox functions) is **not** an outlet secret; it stays a function secret.
- The sheet never sees values: `list_outlets` returns, per secret, `set: true/false` and `last4` (the last 4 characters, only when the value is at least 12 characters long, otherwise `null`). Values are never returned, and never written to `outlet_runs`. Error text returned or logged by `test_connection` is scrubbed of any secret value the adapter used.

## Deploy
1. Apply, in order: `20261101_outlet_sandbox.sql`, `20261101_lab_outlet_templates.sql` (adds `accounts.is_lab` and `caller_account_is_lab()` — **required**), `20261103_outlet_sandbox_manual_campaigns.sql`, `20261104_outlet_sandbox_client_links.sql`, `20261105_outlet_sandbox_admin.sql`. Supabase Vault must be enabled (it already is — `meta_sync_secret` uses it).
2. Deploy **`sandbox-admin` with normal JWT verification** (do **not** pass `--no-verify-jwt`):
   ```bash
   supabase functions deploy sandbox-admin --project-ref fmjefvdtnmgdfauedpmg
   ```
3. Redeploy the other `sandbox-*` functions (`--no-verify-jwt`, as before) so they pick up the Vault-first config loading.
4. Flag your own account: `update accounts set is_lab = true where user_id = '<your auth user id>';`

## API
`POST https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-admin` with `Authorization: Bearer <user access token>` (the iOS app's Supabase session; with `supabase.functions.invoke("sandbox-admin", body:)` this is automatic), body `{ "action": …, "params": {…} }`. Responses: `{ ok: true, action, result }` or `{ ok: false, error }`. `401` not signed in · `403` signed in but not `is_lab` · `400` bad params · `404` unknown outlet.

```bash
export URL=https://fmjefvdtnmgdfauedpmg.supabase.co/functions/v1/sandbox-admin
export JWT=<user access token>      # e.g. from a signed-in session
export ANON=<project anon key>      # curl needs the apikey header too
call() { curl -s $URL -H "Authorization: Bearer $JWT" -H "apikey: $ANON" -H 'Content-Type: application/json' -d "$1"; }
```

| Action | Params | Result |
|---|---|---|
| `list_outlets` | – | `outlets[]`: `outlet, display_name, kind, status, checklist, progress{done,total}, docs_path, notes, updated_at, secrets[{name, required, set, last4}]` — API outlets first, then manual |
| `update_outlet` | `outlet`, and any of `status`, `checklist` (≤30 steps `{key, label, done}`, unique keys), `notes` (`null` clears) | the updated outlet row |
| `set_secret` | `outlet`, `name`, `value` | `{outlet, name, set: true, last4, status}` |
| `delete_secret` | `outlet`, `name` | `{outlet, name, set: false, deleted, status}` |
| `test_connection` | `outlet` (API outlets only) | HTTP 200 always: `{connected: true, detail, checks, status: "connected"}` or `{connected: false, error, missing_config, status}` |
| `list_manual_campaigns` | `outlet`, optional `status`, `limit` (≤200) | `campaigns[]` (rows of `manual_campaigns`) |
| `list_runs` | `outlet`, optional `limit` (≤20, default 20) | `runs[]`: `id, action, status, error, profile_id, hubspot_deal_id, created_at` |

`name` must be one of that outlet's `required_secrets`/`optional_secrets` (the outlet's `secrets[].name` in `list_outlets`).

```bash
call '{"action":"list_outlets"}'
call '{"action":"update_outlet","params":{"outlet":"tiktok","status":"applied","notes":"waiting for app review"}}'
call '{"action":"update_outlet","params":{"outlet":"tiktok","checklist":[{"key":"step_1","label":"Register app","done":true},{"key":"step_2","label":"Wait for review","done":false}]}}'
call '{"action":"set_secret","params":{"outlet":"tiktok","name":"TIKTOK_ADS_ACCESS_TOKEN","value":"<paste>"}}'
call '{"action":"test_connection","params":{"outlet":"tiktok"}}'
call '{"action":"delete_secret","params":{"outlet":"tiktok","name":"TIKTOK_ADS_ACCESS_TOKEN"}}'
call '{"action":"list_runs","params":{"outlet":"tiktok"}}'
call '{"action":"list_manual_campaigns","params":{"outlet":"audiogo","status":"running"}}'
```

## Audit & safety
- Every **mutating** action (`update_outlet`, `set_secret`, `delete_secret`, `test_connection`) is logged to `outlet_sandbox.outlet_runs` as `admin_<action>` *before* it runs (if logging fails the action is refused). `set_secret`/`delete_secret` log the secret **name** only, never the value. The request also records who made the change (`by` = the caller's auth user id). A failed connection test is logged with status `error`. Reads are not logged.
- `test_connection` runs the adapter's `ping()` — a real, read-only API call to the platform (OAuth token exchange + a lookup), with the keys currently in Vault/env. It never creates anything.
- The value you paste travels over TLS to the edge function and over the database connection into Vault; it is not written anywhere else.

## Known limits
- **Supabase Vault itself was not available in the local test environment.** The SQL was tested on Postgres 16 against a stand-in `vault` schema with the same function signatures as the project's existing usage (`vault.create_secret(secret, name, description)`, `vault.update_secret(id, secret)`, `vault.secrets`, `vault.decrypted_secrets`). Check the first `set_secret` on the real project.
- The `is_lab` coupling described at the top.
- The checklist steps are a starting point derived from the per-outlet docs; edit them from the sheet. Manual outlets have no secrets and no connection test.
- Several adapters' request shapes are unverified (see each outlet's doc), so a failed `test_connection` can mean an adapter path needs adjusting, not only a wrong key — the error text says which call failed.
