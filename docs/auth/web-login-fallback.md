# Web login fallback (emailed one-time code)

Status: **built 2026-11-02, not yet live.** The code and migration are in the
repo; the migration is **not applied** and the auth hook is **not enabled** —
see "Implementation" and Will's checklist below. Sections 1–5 are the original
investigation and describe the state *before* this change.
Goal: an existing SQRZ user who signed up with Apple can get into
`dashboard.sqrz.com` with an emailed 6-digit code (OTP) if they lose their
iPhone. Existing users only — it must never create an account. Email channel:
Resend.

Sources: `sqrz-dashboard` (main @ `a63d03e`), `sqrz-ios` (main @ `f205b38`),
`cast` (the repo you called sqrz-cast, `Sqrz-ent/cast`, main @ `1eb4e12`), plus
read-only SELECTs and log/function listings on Supabase project
`fmjefvdtnmgdfauedpmg`. No writes were made anywhere. The shared root
`CLAUDE.md` (one level up) is not in this checkout, so anything it says about
Supabase Auth settings was not available.

## TL;DR

1. **The code-OTP login already exists and is mostly right.**
   `app/routes/login.tsx` calls `signInWithOtp({ shouldCreateUser: false })` and
   `verifyOtp({ type: "email" })`. It needs UX tuning, not a rewrite.
2. **Nothing in any repo calls Resend.** No `resend` import, `RESEND_API_KEY`,
   `api.resend.com`, or email-sending edge function exists. The iOS notes record
   the standing rule "SQRZ sends no email except Supabase Auth's own OTP".
   Resend can only be in play as **custom SMTP configured in the Supabase
   dashboard**, which can't be seen from code. You need to verify that.
3. **The real hole is account creation, not the login page.** `/join` still calls
   `signInWithOtp` *without* `shouldCreateUser: false`, and the DB trigger
   `handle_new_user` makes a profile for every new `auth.users` row. The
   client-side `shouldCreateUser: false` flag is not a security control; anyone
   with the publishable key can call the Auth API directly with
   `create_user: true`. Fix this at the Auth layer (see Decisions).
4. **Where an OTP user lands:** `/` — the full web dashboard. There is no
   maintenance gate in code; "maintenance mode" is only a comment in
   `_app.analytics.tsx`. Details in section 3.
5. **Dead Resend uses to remove: none found in code.** Cleanup is on the
   Resend / Vercel / Supabase-secrets side (section 4).

## Implementation (2026-11-02)

### What changed
| File | Change |
|---|---|
| `app/routes/login.tsx` | Code-first login. Primary button "Email me a login code" (email → 6-digit code); "Use password instead" is the secondary link (password mode keeps "Forgot password?"). `signInWithOtp({ shouldCreateUser: false })` kept. After requesting a code the screen always says "If <email> has an SQRZ account, we've sent a code." — an unknown-email rejection from Supabase (`otp_disabled`/"signups not allowed") is treated as success, so accounts can't be enumerated. Real failures are shown: rate limit, send/SMTP failure, network error, wrong code, expired code. 60 s resend cooldown (also started after a rate-limit error). The "No account found… Sign up →" state and its `/join` link are gone; a footer note says accounts are created in the iOS app. Loader: a signed-in user is still sent to `/`, **except** when `?error=` is present (prevents a `/` ↔ `/login` loop for an account with no profile). |
| `app/routes/join.tsx` | Replaced the whole signup flow (slug picker, `signInWithOtp` without `shouldCreateUser:false`, `pending_signups` slug reservation) with a loader that redirects to `/login`. The route stays registered so old links don't 404. |
| `app/routes.ts` | Comment only; `join` route kept as the redirect. |
| `app/routes/_app._index.tsx` | The four `redirect("/join")` calls now go to `/login`. A signed-in user whose account has no profile is sent to `/login?error=…` with a message instead of the old signup page. |
| `supabase/migrations/20261106120000_before_user_created_hook.sql` | **New, not applied.** `public.hook_before_user_created(event jsonb)`: allows provider `apple`, rejects everything else (email, phone, anonymous, other OAuth) with HTTP 403 "New accounts are created in the SQRZ iOS app." Grants `execute` to `supabase_auth_admin`, revokes from `authenticated`, `anon`, `public`. Includes manual test queries (commented). |
| `docs/auth/web-login-fallback.md` | This section. |

Not changed: `auth.callback.tsx`, `reset-password.tsx`, the `handle_new_user`
trigger, the `pending_signups` table (now unused by app code; the trigger still
reads and cleans it — drop it in a later cleanup), `sqrz-ios`.

### Follow-up cleanup (2026-11-02, second pass)
Login is now **email → 6-digit code only**. Removed: the password login path
and "Use password instead" (`login.tsx`), "Forgot password?" and the
`/reset-password` route (`reset-password.tsx` deleted, route removed from
`routes.ts`), the Account page "Set a Password" card (`_app.account.tsx`), and
the home-page template/theme picker plus its `update_template` action
(`_app._index.tsx`). The dark/light "Appearance" toggle on the home page is
unrelated (cookie-based) and stays. `profiles.template_id` and its data are
untouched. `/join` still redirects to `/login`; no other signup/claim/onboarding
routes existed.
Dashboard consequences: the Supabase **Reset Password** email template and the
"Confirm signup" template are no longer reachable from the web app (leave them
as is); existing users who only had a password now log in with an emailed code.
`/auth/callback` is kept — it still serves admin-generated/invite links.

### Links to `/join` still outside this repo (not touched)
These all hit the redirect, so they are harmless but now lead to a login page
for visitors who wanted to sign up. Repoint them at the App Store / TestFlight
page in the `cast` repo (`Sqrz-ent/cast`): `Nav.svelte` (`joinUrl`),
`CompareLayout.svelte`, `routes/cast/+page.svelte` (2), `routes/blog/[slug]/+page.svelte`,
`routes/compare/*/+page.svelte` (9 pages), and `UsernameChecker.svelte`
(comment/popup flow). `sqrz-ios` has no `/join` links.

### Will's checklist (dashboard steps — I can't do these)
Order matters: do 1–4 and test before 5–6.

- [ ] **1. Resend:** add and verify the sending domain (SPF, DKIM, DMARC DNS
      records); create a sending-only API key for Supabase; revoke unused keys.
- [ ] **2. Supabase → Authentication → Emails → SMTP Settings:** enable custom
      SMTP — host `smtp.resend.com`, port 465 (or 587), user `resend`, password =
      that API key, sender e.g. `login@sqrz.com`.
- [ ] **3. Supabase → Authentication → Emails → Templates → Magic Link:** the
      body must contain `{{ .Token }}` (the 6-digit code). Existing users get this
      template. Without it users receive a link, not a code and the code screen
      is useless. Keep it free of `{{ .ConfirmationURL }}`-only wording.
- [ ] **4. Supabase → Authentication → Sign In / Providers → Email:** enabled;
      set OTP expiry (default 3600 s; 600 s recommended); check the email rate
      limits (custom SMTP lifts the tight built-in cap). OTP length must stay 6
      — the login page accepts exactly 6 digits.
- [ ] **5. Apply the migration** `20261106120000_before_user_created_hook.sql`
      (SQL editor or your normal migration process). Optionally run its manual
      test queries.
- [ ] **6. Supabase → Authentication → Hooks → Before User Created:** enable,
      choose "Postgres function", select `public.hook_before_user_created`.
      **This is what actually blocks account creation — the migration alone
      does nothing.**
- [ ] **7. Verify after enabling:**
  - Apple sign-up on a fresh Apple ID in TestFlight still works (this is the
    one that must not break).
  - Existing email user: login page → code arrives → signs in.
  - Existing Apple user: same, using the email on their account → lands in the
    same profile.
  - Unknown email: login page shows the same "we've sent a code" message and
    **no** row appears in `auth.users`.
  - Direct API check that creation is blocked: `POST /auth/v1/otp` with
    `{"email":"new@example.com","create_user":true}` and the publishable key
    returns 403 "New accounts are created in the SQRZ iOS app."
  - If you use Supabase invites (dashboard "Invite user", `inviteUserByEmail`,
    admin-generated links): test one. The hook may reject them too (see the
    caveat in the migration); if you need them, say so and I'll add a bypass.
- [ ] **8. Apple Developer → Sign in with Apple → Email Communication:**
      register the Resend sending domain and the exact sender address, so
      private-relay (`@privaterelay.appleid.com`) users receive the code.
- [ ] **9. Vercel / Resend cleanup:** confirm `/login` and `/auth/callback` are
      reachable while dashboard.sqrz.com is in maintenance mode; remove unused
      `RESEND_*` env vars and unused Resend keys.
- [ ] **10. `cast` repo:** repoint the `/join` CTAs (list above) at the iOS app.

### Rollback
Disable the hook under Auth → Hooks (immediate). The login page changes are
plain code; reverting the commit restores the old login page, and `/join` signup
is restored by reverting `app/routes/join.tsx`.

### Decisions I made (change if you disagree)
- **Allowlist, not blocklist:** the hook rejects *every* provider except Apple,
  not just email/phone. Add providers in a new migration if you ever need them.
- **Neutral responses everywhere on the request step**, including the unknown
  email case; the only way to learn whether an account exists is to receive the
  email.
- **No-profile account** goes to `/login?error=…` rather than being auto-created
  or signed out; it can still request a code for a different email.
- Resend cooldown is client-side only (60 s, matches Supabase's default per-email
  limit, which is the real enforcement). No captcha / IP throttling was added —
  still an open decision (see Open decisions 4).

## Original investigation (state before this change)

## 1. What exists in sqrz-dashboard

Auth is Supabase Auth via `@supabase/ssr`, **implicit flow**
(`app/lib/supabase.client.ts`, `app/lib/supabase.server.ts`). The browser client
syncs the session to cookies, so server loaders see it.

| File | What it does | State |
|---|---|---|
| `app/routes/login.tsx` | Email field, then either password login or **"Send code"** (6-digit entry, "Resend code", "Use a different email"). `sendCode()` → `signInWithOtp({ email, options: { shouldCreateUser: false } })`; `verifyCode()` → `verifyOtp({ email, token, type: "email" })`, then `window.location.href = "/"`. | Works. See gaps below. |
| `app/routes/join.tsx` | Web signup: handle, email, 6-digit code. `signInWithOtp` with `data: { slug }` and **no** `shouldCreateUser: false`; reserves the slug in `pending_signups` via the service-role client. | Live. Creates accounts. |
| `app/routes/auth.callback.tsx` | Handles `?code=` (PKCE), `?token_hash=&type=` (`verifyOtp`), and `#access_token=` hash flows; `safeNextPath()` blocks open redirects. | Fine. Not needed for the code flow; only for link emails. |
| `app/routes/reset-password.tsx` | `resetPasswordForEmail`, redirect to `/auth/callback`. | Live. After the link the user lands logged in at `/` (no set-password step; they must go to Account). |
| `app/routes/_app.account.tsx` | "Set a Password" card (copy still says "log in without a magic link"). | Live. |
| `app/routes.ts` | Public: `join`, `login`, `reset-password`, `auth/callback`. Everything else under `_app` layout needs a session. | — |

Email templates: **none in the repo.** No `supabase/config.toml`, no
`supabase/templates/`, no `[auth.email]` config. Templates (if customised) live
only in the Supabase dashboard.

Resend usage: **none.** `grep -ri resend` across all three repos hits only UI
text ("Resend code") and an iOS CLAUDE.md note on an audit.

### Gaps in `login.tsx` for the fallback use case

- **Password-first UI.** The primary button is "Login with password"; "Send
  code" is a small grey text link. Apple users have no password
  (`has_password = 0` for the apple identity), so the fallback is easy to miss.
- **Every error is "No account found with that email. Sign up →".** The `catch`
  swallows all errors, so rate limits, SMTP failures and "email not sent" all
  show as "no account". The "Sign up →" link points to `/join`.
- **Account enumeration.** Distinguishing unknown from known emails leaks which
  addresses have accounts. Prefer a neutral message ("If that email has an
  account, we've sent a code") and always advance to the code screen.
- **No resend cooldown, no attempt feedback.** Supabase enforces a per-email
  rate limit (default 60 s), but the UI doesn't surface it.
- **Success redirect is a hard `window.location.href = "/"`** (fine; ensures
  the cookie is picked up by the loader).
- **No explanation for Apple users.** Nothing says "signed up with Apple? use
  the email you gave Apple."

## 2. Supabase Auth setup (as far as visible)

Visible from code/data:

- **Email OTP is in use** (login and join), 6 digits, `type: "email"`.
- **Custom SMTP / Resend: not referenced anywhere in code.** Not verifiable
  from here — it's a dashboard setting (Authentication → Emails → SMTP).
  Auth logs for the last 24 h show only 6 `Login` events, so there's no
  recent OTP-send volume to infer the sender from.
- **Email signups are allowed in code**: `join.tsx` creates users via OTP;
  `handle_new_user` (live definition read via `pg_get_functiondef`) inserts a
  `profiles` row for any new `auth.users` row, with `user_type = 'member'`,
  and links an existing unclaimed profile by email. So **any** new auth user —
  including one created by a direct API call — gets a profile.
- **`shouldCreateUser: false` is only on `login.tsx`.** It's a request flag the
  client sends; it protects the login page's behaviour, nothing more.
- **Whether "Allow new users to sign up" is on in the dashboard: unknown.**
  Note it can't simply be switched off: iOS creates *new* users through
  `signInWithIdToken` (Apple, `SignUpView.swift`), and that path is also
  blocked by the global signup toggle.
- iOS auth (`sqrz-ios`): Apple sign-in (`signInWithIdToken`) plus
  email+password; **no OTP/magic link** by design ("email interruption breaks
  native flow"). `LoginView.swift`'s header comment says Apple-only, while iOS `CLAUDE.md`
  still lists email+password as primary; the two disagree, so confirm.
- `cast` (marketing site): only links out to `dashboard.sqrz.com/login` (a `Login`
  link exists in `Nav.svelte`, desktop bar and menu panel; a 2026-08-14 comment
  says nav login/signup were removed to steer traffic to iOS, so check the live
  site) and `/join`. No auth code.

Read-only data points (aggregate counts only, no addresses):

| auth.users identity | users | relay emails | has password |
|---|---|---|---|
| email | 6 | 0 | 6 |
| apple | 1 | 0 | 0 |
| none (no email) | 5 | — | 0 |

- The one Apple user has a real, confirmed email (not `privaterelay`), so OTP
  to that address resolves to the **same** `auth.users` row: Supabase looks the
  user up by email, so an OTP login lands in the same account/profile, not a
  duplicate. (The 5 no-identity, no-email rows look like anonymised deleted
  accounts from `delete-account`; not investigated further.)
- **Future Apple users who choose "Hide My Email"** have a
  `@privaterelay.appleid.com` address. An OTP sent there only reaches them if
  the sending domain/address is registered in Apple's Private Email Relay
  configuration (Apple Developer → Services → Sign in with Apple for Email
  Communication). Without that, the code is silently dropped. Zero such users
  exist today, but this is exactly the audience for the fallback.

Settings I could not see and you should check (all in the Supabase dashboard):
custom SMTP host/sender, the *Magic Link* email template, OTP expiry and
length, rate limits, "Allow new users to sign up", Site URL / redirect URLs,
any auth hooks.

## 3. Where an OTP-logged-in user lands, and what they can do

- `login.tsx` → hard redirect to `/` → `_app.tsx` layout loader (needs
  `getUser()`, else `/login`; loads `getCurrentProfile`) → `_app._index.tsx`.
- **No maintenance gate exists in code.** No middleware, banner or flag. The
  only "maintenance" text is a comment in `_app.analytics.tsx`: the web
  dashboard is "maintenance-mode back office, iOS is primary", and that route
  was reduced to a promo page. If dashboard.sqrz.com is *actually* in
  maintenance mode, that's enforced outside this repo (Vercel/domain level) —
  worth confirming that `/login` and `/auth/callback` are reachable there.
- `/` home: profile summary, last-7-day view/visitor analytics (service-role
  reads scoped to the user's profile id), completion checklist, template picker
  (the only action on that route: `update_template`), share link, theme toggle.
  If the user has no profile row, loaders `redirect("/join")`.
- Nav: Dashboard `/`, Profile `/profile`, Business `/service`, Account
  `/account`; bottom nav Profile / Leads `/office` / Grow `/grow` / Preview.
- Capabilities after an OTP login: full profile editing, services/business
  settings, leads inbox with archive / keep-active, account (domain, set a
  password, sign out). `/grow` ("Grow", moved from `/analytics`) is a promo page linking to the
  TestFlight invite. Wallet top-up (`api/wallet/topup`), campaign budget
  checkout, advisor endpoints and Stripe webhook exist as API routes.
  Account deletion is iOS-only (Apple token revocation), so it can't be done
  from the web.
- An OTP session is a normal access-token + refresh-token session (lifetimes
  per the dashboard JWT settings), identical to a password session. No distinction, no reduced scope.
- Apple-linked data note: because a fallback user has lost their phone, their
  APNs token stays on the profile (sign-out can't run). Nothing in the web flow
  clears it; consider a "sign out of all devices" action later.

## 4. Dead Resend uses

**Code: none to remove.** Evidence: no matches for `resend`/`RESEND_API_KEY`/
`api.resend.com` in sqrz-dashboard, sqrz-ios or cast; the deployed edge
functions (`list_edge_functions`: hubspot-*, meta-*, sandbox-*, apple-*, apns-push,
campaign/profile-advisor, redeem/get-or-create-invite-code, delete-account,
generate-invoice, quick-action, credits, area-fetch…) include no email sender;
sqrz-ios `CLAUDE.md` (2026-08-16) records an exhaustive Resend audit whose
result is "SQRZ sends no email except Supabase Auth's own OTP".

- Old web-signup verification: now Supabase OTP in `join.tsx`, not Resend.
- Booking emails: booking pipeline removed (`20260731_leads_only_model…`
  migrations); no sender code remains.

Things that *are* stale and adjacent:
- `.vercel/react-router-build-result.json` is **tracked in git** (despite
  `.vercel` in `.gitignore`) and still lists removed routes (`claim`,
  `claim.confirm`, `booking.$id`, `api.booking.create`, `api.booking.deliver`).
  Removing it from the index is safe and avoids confusion.
- `login.tsx`/`join.tsx` link copy and `_app.account.tsx` "log in without a
  magic link" wording.

**Outside the repos (you need to check, I can't):** unused Resend API keys,
webhooks and domains in the Resend dashboard; any `RESEND_*` env var in
Vercel; any Resend secret in Supabase Edge Function secrets (I did not list
secrets). Revoke what is unused; keep only the key that Supabase SMTP uses.

## 5. Build plan

Principle: reuse `login.tsx`; spend the effort on making account creation
impossible through any path other than Apple.

### sqrz-dashboard (code)
1. `login.tsx`: make "Email me a code" a first-class option (code-first, or a
   clear "Lost your iPhone? Get a code by email" action); neutral response
   regardless of whether the email exists; show real errors (rate limit,
   send failure) distinctly; resend cooldown (60 s); remove the "Sign up →"
   link from the error state; keep `shouldCreateUser: false`.
2. `join.tsx`: either retire web signup (route → redirect to the iOS app /
   TestFlight page — consistent with the 2026-08-14 "steer to iOS" decision) or
   keep it but accept that Auth-layer protection (below) must allow its
   provider. Retiring it also removes `pending_signups`, `reserve-slug` and the
   slug-in-metadata path.
3. Optional hardening: a server-side action that wraps `signInWithOtp`
   (service key never exposed) with per-IP + per-email throttling and a
   Turnstile/hCaptcha check; Supabase's built-in rate limits are per email, not
   per IP. Adds a route, so it's a decision (below).
4. Tidy: copy on Account page, untrack `.vercel/…json`.
5. Test plan: existing user (email) logs in by code; Apple-created user logs
   in by code and sees the same profile; unknown email gets the neutral
   response and no `auth.users` row is created; expired/wrong code; resend
   cooldown; relay-email user.

### Supabase (Database / config — migrations are your call; not done here)
- Block user creation outside Apple: a **Before User Created** auth hook
  (Postgres function) that rejects when the provider is `email` (allow `apple`).
  This is what makes the fallback safe even against direct API calls, without
  turning off signups globally (which would break iOS Apple signup). If web
  signup is retained, the hook must allow it instead.
- Confirm the Magic Link template includes `{{ .Token }}` (the 6-digit code),
  not just `{{ .ConfirmationURL }}`; otherwise users get a link, not a code.
  Existing users receive the *Magic Link* template; new users the *Confirm
  signup* one — keep both consistent.
- Set OTP expiry (default 3600 s; 600 s is reasonable) and check the OTP rate
  limit.

### sqrz-ios
- No functional change required (fallback is web-only by design). Optional:
  copy in the Apple sign-in/account screen telling users which email to use
  for the fallback; a way to see the email on file.
- If "hide my email" is used, register the sending domain with Apple (see below).

### cast (marketing site)
- `Nav.svelte` already links `dashboard.sqrz.com/login`; no change needed.
  Revisit `/join` CTAs (several pages) if web signup is retired.

### What you must configure yourself
Supabase dashboard:
- Authentication → Emails → **SMTP Settings**: Resend (`smtp.resend.com`,
  port 465/587, user `resend`, password = a Resend API key), sender such as
  `login@sqrz.com` on a verified domain.
- Authentication → Emails → **Templates**: Magic Link template with
  `{{ .Token }}`; set subject/branding.
- Authentication → **Sign In / Providers**: Email enabled; confirm "Allow new
  users to sign up" state; set OTP expiry; Rate Limits (email sent/hour — the
  built-in SMTP is tightly capped, custom SMTP raises it).
- Authentication → **Hooks**: register the Before User Created hook (after
  the function is deployed).
- Authentication → URL Configuration: Site URL and redirect URLs
  (`https://dashboard.sqrz.com/**`).
Resend dashboard:
- Add and verify the sending domain (SPF, DKIM, DMARC DNS records at your DNS
  host); create a scoped sending-only API key for Supabase; revoke unused keys.
Apple Developer:
- Sign in with Apple → Configure **Email Communication**: register the Resend
  sending domain and the exact sender address so private-relay addresses
  receive the code.
Vercel:
- Confirm `/login` is reachable under maintenance mode and that no unused
  `RESEND_*` env vars remain.

### Open decisions
1. Keep or retire web signup (`/join`)? Retiring is the simplest path to
   "existing users only" and matches the iOS-first direction. It affects
   `cast` CTAs and the `pending_signups` flow.
2. Auth-layer block: Before User Created hook (recommended) vs. accepting the
   residual API-level creation risk. Global signup disable is **not** viable
   because of iOS Apple signup.
3. Enumeration: neutral message (recommended) vs. today's explicit "no
   account".
4. Add a throttling / captcha wrapper route, or rely on Supabase's built-in
   per-email limits?
5. Session policy for fallback logins: shorter session? notify the user by
   email "someone signed in"? Should an OTP login be allowed to change the
   password / email on the account without re-verification?
6. Scope inside maintenance mode: should fallback users get the whole web
   dashboard, or a minimal "recover your account / get the app / sign out of
   all devices" page?
7. Apple relay-email users: accept that some will be unreachable, or collect a
   backup email in-app now (iOS change).
