# Web dashboard Pro gate

Status: **in code (2026-11-02). Needs one env var before it works — see "Before this deploys".**

Signed-in users **without SQRZ Pro** can log in (emailed-code login is unchanged)
but every dashboard route redirects to `/pro-required`. Users **with Pro** get the
full dashboard (switcher, balance, top-up, campaigns…).

## What "Pro" is
Exactly what the iOS app treats as Pro (`EntitlementManager`): the RevenueCat
entitlement **`grow_access`** or the additive **`multichannel_access`** being
*active* (no expiry = lifetime, expiry in the future, or inside a billing grace
period). RevenueCat is the only source of truth for every way of holding it —
App Store purchase/subscription, invite-code promo grants (`redeem-invite-code`)
and a template's Pro period (`_shared/pro-grant.ts`, `campaign_templates.pro_days`).
No table mirrors it (`ios_subscriptions` is the separate Companion subscription),
so nothing new is synced.

## How it is checked
`app/lib/pro.server.ts` → `GET https://api.revenuecat.com/v1/subscribers/{auth user id, lowercase}`
with `REVENUECAT_SECRET_API_KEY` (the same secret the edge functions use).
- Cached **in memory per user**: Pro 5 min, free 30 s (so a fresh upgrade gets in
  quickly), errors 10 s. "Check again" on the gate page can bypass the cache at
  most once per 10 s.
- **Kill switch:** follows the same flag as iOS, `app_config.purchase_gate_enabled`
  (currently `true`). Set it `false` and Pro gating is off for iOS **and** web, no deploy.
- **Fail closed:** if RevenueCat is unreachable or the key is missing the user is
  *not* let in; the gate page then says "couldn't verify" instead of "part of SQRZ
  Pro" so a paying user isn't told they're free.

## Where it is enforced (server-side, never only UI)
- `requirePro()` (redirect to `/pro-required`): the `_app` layout loader **and**
  every dashboard route's loader/action — `_app._index`, `account` (sign-out stays
  open), `analytics`, `campaigns`, `campaigns/:id`, `notifications`, `office`,
  `profile`, `service`. (Child actions don't run the layout loader, so each checks itself.)
- `proDeniedResponse()` (403 JSON `{error:"SQRZ Pro required"}`) on the
  **cookie-authenticated (web)** path of `api/wallet/topup`,
  `api/campaigns/refresh-stats`, `api/campaigns/budget-checkout`,
  `api/campaign-advisor`, `api/profile-advisor`, `api/messaging/stream-inquiry(-keep-active)`.
  **Bearer (iOS app) calls are untouched** — the app has its own entitlement handling.
- Not gated: `/login`, `/join` (redirect), `/auth/callback`, `/pro-required`,
  `api/active-profile` (no data), the Stripe webhook, `.well-known`.

## `/pro-required` page
The active profile's public link (`https://<slug>.sqrz.com`), the note "The SQRZ web
dashboard is part of SQRZ Pro — available in the SQRZ app", "Check again", a contact
link (`mailto:` `SUPPORT_EMAIL`, default `will@sqrz.com`) and Log out. No purchase
or checkout link.

## Before this deploys (Will)
1. **Set `REVENUECAT_SECRET_API_KEY` in this app's Vercel environment** (same value
   as the Supabase edge function secret; RevenueCat → API keys → secret `sk_…`).
   Until it is set **every user, including you, lands on the gate page** (error state).
   Set it *before* the push to `main` deploys, or redeploy after setting it.
2. Optional: `SUPPORT_EMAIL` to change the contact address (default `will@sqrz.com` — confirm it's right).
3. Test: a Pro account gets the dashboard; a non-Pro account lands on `/pro-required`;
   grant a promo in RevenueCat and use "Check again".
4. Rollback without a deploy: set `app_config.purchase_gate_enabled = false`
   (affects iOS too). Or revert the commit.

## Known limits
- The cache is per server instance (serverless), so different instances may each
  call RevenueCat once per TTL; still far fewer calls than one per page.
- `GET /subscribers/{id}` creates a RevenueCat customer record for an id RevenueCat
  hasn't seen (a user who never opened the app) — harmless, but they show up there.
- Users who hold Pro under a *different* RevenueCat id (e.g. an uppercase/anonymous
  id from before the app lowercased ids) won't be recognised; the app's id is the
  lowercase Supabase user id.
