# Campaign templates with a Pro period (`campaign_templates.pro_days`)

Status: **code + migration written 2026-11-02; migration NOT applied, edge
functions NOT deployed.** No `pro_days` values are set — Will sets them.

## Behaviour
A campaign template can include a Pro period. When someone buys that template's
activation IAP, the purchase also grants **Pro** (the RevenueCat `grow_access`
entitlement) for `pro_days` days.

- `campaign_templates.pro_days` — integer, nullable, `CHECK (pro_days IS NULL OR pro_days >= 0)`.
  NULL or 0 = no Pro included. Edit it in the Table Editor / Airtable.
- Pro = `grow_access`, the same entitlement `redeem-invite-code` grants, via the
  same RevenueCat v1 *promotional entitlement* API (`REVENUECAT_SECRET_API_KEY`,
  already required by that function).

## Where the grant happens
Shared helper: `supabase/functions/_shared/pro-grant.ts` → `grantProForActivation(supabase, transactionId)`.
It runs **after** `record_campaign_activation` has recorded the purchase, from:

1. `verify-campaign-activation` — the primary, client-initiated path (also on the
   "already used" 409 path, to heal a failed first attempt).
2. `apple-consumable-webhook` — `ONE_TIME_CHARGE` backup path (also on its
   "already recorded" and race paths).

A failed grant **never** fails or reverts the activation; the next retry/webhook
tries again. `verify-campaign-activation` returns `pro: { status, days?, until? }`
(informational).

## Extending, not overwriting
`new end = max(current promotional end, now) + pro_days`, sent to RevenueCat as an
explicit `end_time_ms` (`POST /v1/subscribers/{id}/entitlements/grow_access/promotional`).

1. `GET /v1/subscribers/{id}` → look at `entitlements.grow_access`.
2. If it is a promotional grant (`product_identifier` starts with `rc_promo_`):
   - `expires_date` null → **lifetime promo** (e.g. an invite code): nothing to
     extend; recorded as 0 days, no grant.
   - otherwise base = max(`expires_date`, now).
3. A paid subscription, an expired entitlement or none → base = now.
4. Grant `end_time_ms = base + pro_days * 86400000`.

RevenueCat app user id = the Supabase auth user id, **lowercase** (what sqrz-ios
passes to `Purchases.logIn`), resolved server-side from `profiles.user_id`.
RevenueCat treats a grant whose end is within 2 hours of an existing promotional
grant's end as a duplicate; `pro_days >= 1` is always far outside that.

## Idempotency (per purchase)
Recorded on the `campaign_activations` row:

| column | meaning |
|---|---|
| `pro_granted_at` | grant decision finalised — non-null means **never grant again** for this transaction |
| `pro_days_granted` | days granted (0 = template had no Pro at purchase time, or user already had lifetime Pro) |
| `pro_granted_until` | resulting Pro end |
| `pro_grant_started_at` | claim marker while RevenueCat is being called; stale after 5 min |

Flow: read row → if `pro_granted_at` set, return it; otherwise atomically *claim*
(`UPDATE … WHERE pro_granted_at IS NULL AND (claim IS NULL OR stale)`), call
RevenueCat, then finalise. If RevenueCat fails the claim is released and the next
retry grants. A purchase made while `pro_days` was NULL/0 is **finalised as "no
Pro"** — raising `pro_days` later does not retroactively grant on a retry.

Known residual risk: if RevenueCat grants but the final DB write fails 3 times,
the function logs `GRANTED but FAILED TO RECORD` and a later retry could extend a
second time. Reconcile from RevenueCat if you ever see that log line.

## Not handled (decisions for Will)
- **Refunds** (`REFUND` in `apple-consumable-webhook`) mark the activation refunded
  but do **not** revoke the Pro period. Revoking would remove *all* promotional
  grants for the entitlement (RevenueCat limitation), including invite-code ones.
- Concurrent purchases by one user could compute the same base time; practically
  irrelevant for one-at-a-time IAP.
- Only `grow_access` is granted, never `multichannel_access`.

## iOS (sqrz-ios)
- `CampaignTemplateConfig.proDays` decodes `pro_days` as optional (older builds and
  databases without the column keep working). The template card shows
  "Includes 3 months of Pro" (under 30 days: "Includes 10 days of Pro"; otherwise
  rounded months) when `pro_days > 0`.
- After a purchase whose response says `pro.status == "granted"`, the app
  invalidates RevenueCat's cached customer info and refreshes the entitlement
  **before** choosing the next screen. Side effect: a free user who buys a
  Pro-bundled template is routed to the Pro "Allocate budget" screen instead of the
  free-tier budget payment screen.

## Deploy / rollout checklist (Will)
1. Apply `supabase/migrations/20261107120000_campaign_template_pro_days.sql`.
2. Confirm `REVENUECAT_SECRET_API_KEY` is set in the edge function secrets
   (it is required by `redeem-invite-code` already).
3. Deploy `verify-campaign-activation` and `apple-consumable-webhook`
   (both import the new `_shared/pro-grant.ts`; keep their existing `verify_jwt` settings).
4. Set `pro_days` on a template, then test in sandbox: buy it, check
   `campaign_activations.pro_granted_until` and the customer in RevenueCat; replay the
   webhook and confirm nothing is granted twice; buy a second one and confirm the end
   moved by `pro_days` from the previous end.
5. Ship the iOS build.
