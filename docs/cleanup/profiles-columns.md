# `profiles` column usage audit (pre-drop investigation)

Read-only investigation, 2026-11-01. No migrations, no data changes. Supabase project `fmjefvdtnmgdfauedpmg`, `profiles` table currently has **14 rows total**.

## Execution (2026-11-02) — code removed, migration written, NOT applied

Will confirmed dropping all 12 code-dead columns, **plus `is_demo`** (flagged "confirm with Will first" below — now confirmed, included in the drop). `stripe_beta_test_mode` and `is_partner` stay, per the audit's own recommendation; `stripe_customer_id`/`stripe_customer_id_test` were out of scope throughout (never flagged for removal).

**Code changes** (all repos, build-verified):
- **sqrz-ios** (`Models/Profile.swift`) — removed `isBeta`/`is_beta` (non-optional `Bool`, the real TestFlight decode-risk field) and `showGigHistory`/`show_gig_history` (optional, zero readers) + their `CodingKeys` cases. `xcodebuild` clean.
- **sqrz-dashboard** (`app/routes/_app.tsx`) — removed the `is_beta`-gated "Beta" nav badge (the whole now-empty trailing `<div>` was removed too, not left as dead markup). `supabase/functions/delete-account/index.ts` — stopped writing `availability_status`/`is_claimed` (scrub A) and `stripe_connect_id`/`_test`/`stripe_connect_status`/`_test`/`claim_token` (scrub B); the "silences `generate_claim_token_for_trigger()`" comment went with it since that trigger is dropped in the same migration. `npm run typecheck` clean on `app/` (the only errors anywhere are pre-existing Deno-vs-Node tsconfig noise across every edge function, unrelated to this change — confirmed present on untouched functions too).
- **sqrz-profiles** (`app/api/links/checkout/route.ts`) — removed the Connect-account lookup/gate (`stripe_connect_id`/`stripe_connect_status`, hard-required `status === 'active'`) and the destination-charge `transfer_data`. The route now creates a plain Stripe Checkout session charged directly to the SQRZ platform account — payment-gated private links keep working for the visitor, just without a Connect split (which could never actually fire again: 0/14 profiles have ever reached `status = 'active'`, and Connect onboarding is gone from every client). `npm run build` clean.
- **sqrz-cast** — no changes; the earlier investigation found zero references to any of these columns.

**Migration written, not applied**: `sqrz-dashboard/supabase/migrations/20261102_drop_dead_profile_columns.sql` — rewrites `handle_new_user()` (drops the claim_token-matching branch + `is_claimed` references), drops triggers `set_claim_token`/`on_claim_token_set` + their functions (`generate_claim_token_for_trigger`, `auto_qualify_seeded_profile`) + both orphaned `generate_claim_token` overloads, recreates `profile_hubspot_enrichment` without `stripe_connect_status`/`onboarding_completed`/`grow_qualified` (and the derived `stripe_connected`), then drops the 12 columns (their 3 dependent indexes — `profiles_claim_token_key`, `profiles_claim_token_idx`, `profiles_is_claimed_idx` — go automatically with `claim_token`/`is_claimed`). Header comment flags the iOS-build-must-ship-first dependency for `is_beta`. **Apply only after confirming the `is_beta`-free iOS build has reached all active TestFlight testers** (non-optional field — an older build would throw a `DecodingError` on every profile load otherwise).

Repos checked: sqrz-ios, sqrz-dashboard (app + `supabase/migrations` + `supabase/functions`), sqrz-profiles, sqrz-cast. DB checked directly: `pg_proc` (functions/triggers), `pg_trigger` (attached triggers only), `pg_policies` (RLS), `pg_views`, `cron.job`, deployed edge functions (remote list, which includes several functions not described in any repo's CLAUDE.md — audited the ones plausibly touching `profiles`).

---

## 1. `stripe_connect_id` / `stripe_connect_id_test`

**Code references**
- **sqrz-dashboard**: only written — `supabase/functions/delete-account/index.ts` nulls both on account deletion (PII scrub). No reads anywhere in `app/`. No `/api/stripe/connect`-style route exists in this repo at all (checked — zero matches for any onboarding route); whatever used to populate these columns is gone.
- **sqrz-profiles**: `app/api/links/checkout/route.ts` **reads `stripe_connect_id`** (live) — fetches the private-link owner's Connect account to build a Stripe destination charge for a payment-gated private link (`payment_gate = true`). Still wired into `app/[slug]/page.tsx`'s rendering (`payment_gate` branch), so this is a real, reachable code path, not dead code — see §3/§5 for why it's dead-in-practice anyway.
- **sqrz-ios**: zero references (grepped `stripeConnectId`/`stripe_connect_id`, both bare and `_test`).
- **sqrz-cast**: zero references.

**Database references**: no functions, triggers, views, RLS policies, or cron jobs reference `stripe_connect_id_test`. `stripe_connect_id` (non-test) is not referenced anywhere at the DB level either — the migration that added the `_test` sibling (`20260513_add_parallel_stripe_test_mode.sql`) only touches the `_test` column.

**iOS decode risk**: none — not modeled in any Swift `Codable` type.

**Current data**: `stripe_connect_id` set on 1/14 rows; `stripe_connect_id_test` set on 1/14 rows.

**Recommendation**: **Drop, together with `stripe_connect_status`** (see below — the two are read as a pair by the one live consumer). Before dropping: the sqrz-profiles payment-gated-link checkout route (`app/api/links/checkout/route.ts`) needs its Connect-account lookup removed or reworked first, since it's a real `SELECT` against these columns. `stripe_connect_id_test` can be dropped independently right away — it has no DB or live-app reader at all, only the deletion scrub, which is safe to also remove in the same pass.

---

## 2. `stripe_connect_status` / `stripe_connect_status_test`

**Code references**
- **sqrz-dashboard**: same as above — only nulled by `delete-account`. No reads, no onboarding writer anywhere in the repo.
- **sqrz-profiles**: `app/api/links/checkout/route.ts` reads `stripe_connect_status` and **hard-requires it to equal `'active'`** before allowing a destination-charge checkout session; `app/[slug]/page.tsx` doesn't read the status column itself, only `payment_gate`/`price`/`currency`.
- **sqrz-ios**: zero references.
- **sqrz-cast**: zero references.

**Database references**: `profile_hubspot_enrichment` (a view) selects `stripe_connect_status` and derives `stripe_connected = (stripe_connect_status = 'active')`. The one real consumer of that view, the `hubspot-sync-contact` edge function (triggered by `on_profile_hubspot_sync`), does `select("*")` against the view but **only destructures `first_name`/`last_name`/`city`/`website_url`/`hubspot_contact_id`** from the result — `stripe_connect_status`/`stripe_connected` are fetched and silently discarded. No other function/trigger/cron references either column.

**iOS decode risk**: none.

**Current data**: `stripe_connect_status` is set (non-null) on 13/14 rows — but the live values are `not_connected` (12), `pending` (1), and 1 null. **Zero rows are `'active'`.** `stripe_connect_status_test` is set on 1/14 rows.

**Recommendation**: **Drop, both variants.** There is no Stripe Connect onboarding flow left anywhere in the codebase (no `/api/stripe/connect` route in sqrz-dashboard, nothing in iOS — matches sqrz-ios's own CLAUDE.md "Payments Policy" noting Connect onboarding was removed 2026-08-03) — so no current code path can ever move a profile to `'active'`. The one live reader (sqrz-profiles checkout route) is therefore permanently unreachable in practice even though it's technically wired: it can never pass its own `connectStatus !== "active"` gate. Before dropping, either delete that dead-but-live checkout route + its `payment_gate` UI, or at minimum confirm with Will that payment-gated private links are fully retired (0 `active` Connect accounts suggests they already are). `profile_hubspot_enrichment`'s view definition needs to drop the `stripe_connect_status`/`stripe_connected` columns in the same pass (a view blocks `DROP COLUMN` on a column it references).

---

## 3. `stripe_beta_test_mode`

**Code references**
- **sqrz-dashboard**: **actively read, live.** `app/routes/api.wallet.topup.tsx` and `app/routes/api.campaigns.budget-checkout.tsx` both read `profile.stripe_beta_test_mode` to pick `StripeMode` ("test" vs "live") for the Stripe secret key / Connect mode used in wallet top-ups and campaign-budget checkout. Doc comments in `app/lib/walletPayments.server.ts` and `app/lib/stripe.server.ts` describe it as "the flag, same for web and native." Not written anywhere in the repo (no UI toggle found) — it's a manually-flipped DB value per the comments.
- **sqrz-ios / sqrz-profiles / sqrz-cast**: zero references.

**Database references**: referenced only in a migration comment (`20260731_add_stripe_mode_to_wallet_ledger_and_fees.sql`, explaining that iOS wallet top-up/Start Campaign checkout is currently forced to test mode "regardless of `profile.stripe_beta_test_mode`"). No function/trigger/view/RLS/cron references it.

**iOS decode risk**: none — not modeled in Swift.

**Current data**: 0/14 rows have it `true` (all default `false`).

**Recommendation**: **Keep.** This is a live, actively-read switch for two real Stripe checkout code paths on web, even though no row currently has it flipped and there's no UI to flip it (must be set by hand in Supabase). Not a cleanup candidate.

---

## 4. `claim_token`

**Code references**
- **sqrz-dashboard**: only written as `null` by `delete-account`'s PII scrub, with a comment explaining the write order relative to a DB trigger (see below). The `/claim` + `/claim/confirm` routes that used to issue/consume this were deleted 2026-08-08 (confirmed — no trace in `app/routes/`). The RPC `generate_claim_token(p_slug text)` (a different, SQL-only, non-trigger function with the same name — overload) still exists but has zero callers anywhere in the repo.
- **sqrz-profiles**: zero references — the `?claim=TOKEN` banner on `app/page.tsx` is fully gone, confirmed by grep (not just per CLAUDE.md's note).
- **sqrz-ios / sqrz-cast**: zero references.

**Database references** — this column is still structurally load-bearing at the DB level even though no client can drive it anymore:
- `handle_new_user()` (the `auth.users` signup trigger) reads `raw_user_meta_data->>'claim_token'` and, if present, matches it against `profiles.claim_token` to link a pre-seeded profile to a new signup. Since no client ever sends `claim_token` metadata anymore (the one sender, `claim.tsx`, is deleted), this branch is dead-but-wired, not literally unreachable by schema.
- **Two separate trigger functions** both still fire on every `profiles` INSERT/UPDATE and both independently try to generate a `claim_token` when `is_claimed = false AND claim_token IS NULL`: `generate_claim_token_for_trigger()` (trigger `set_claim_token`, `BEFORE INSERT OR UPDATE` on all of `profiles`) and `auto_qualify_seeded_profile()` (trigger `on_claim_token_set`, `BEFORE INSERT OR UPDATE OF claim_token`, which also sets `grow_qualified = true` when a `claim_token` first appears). A third version, the argumentless `generate_claim_token()` function, has the identical body but **is not attached as a trigger** — confirmed via `pg_trigger` — it's dead/orphaned, not live.
- `delete-account`'s own comment flags exactly this: it sets `is_claimed = true` specifically to "silence `generate_claim_token_for_trigger()`'s regeneration."

**iOS decode risk**: none — not modeled.

**Current data**: 0/14 rows have a `claim_token` set right now (consistent with all 14 rows already being `is_claimed = true`, so neither trigger fires).

**Recommendation**: **Drop**, but as a *trigger cleanup first, column second* — this is the one column here with genuine orphaned-trigger risk if dropped carelessly (same class of gap root CLAUDE.md flags elsewhere for other columns: a bare `DROP COLUMN` doesn't touch trigger function bodies, so `set_claim_token`/`on_claim_token_set` would start throwing on every future `profiles` write). Drop `set_claim_token`/`generate_claim_token_for_trigger()`, `on_claim_token_set`/`auto_qualify_seeded_profile()`, and the dead argumentless `generate_claim_token()` function in the same migration as the column, and remove the `claim_token` branch from `handle_new_user()`.

---

## 5. `claimed_at`

**Code references**: zero in any of the four repos. (A different table, `beta_slug_holds`, has its own unrelated `claimed_at` column — not to be confused; that one is live via `mark_beta_slug_claimed()`.)

**Database references**: no function/trigger/view/RLS/cron references `profiles.claimed_at` specifically (only the unrelated `beta_slug_holds.claimed_at`).

**iOS decode risk**: none.

**Current data**: 2/14 rows have it set (frozen historical data from the old claim flow).

**Recommendation**: **Drop.** Fully inert — no reader, no writer anywhere, at any layer.

---

## 6. `is_claimed`

**Code references**
- **sqrz-dashboard**: `delete-account` explicitly sets it to `true` on deletion (to suppress claim-token regeneration, see §4). No other reads/writes in `app/`.
- **sqrz-ios / sqrz-profiles / sqrz-cast**: zero references.

**Database references**: `handle_new_user()` filters on `is_claimed = false` (twice — once for the `claim_token` match, once for the email-fallback match) when deciding whether an incoming signup should attach to a pre-seeded profile row instead of creating a new one. Both `claim_token`-generating triggers (§4) also gate on `is_claimed = false`. This column is the actual gate that keeps those triggers/that signup branch from firing on normal rows.

**iOS decode risk**: none.

**Current data**: 14/14 rows are `true`, 0 are `false`. Every current profile is "claimed."

**Recommendation**: **Drop together with `claim_token`/`claimed_at`**, not independently — it's structurally entangled with `handle_new_user()`'s pre-seeded-profile matching branch and both claim-token triggers. Removing `is_claimed` alone would require rewriting those three pieces of logic anyway, so do it as one migration: drop the triggers, rewrite/trim `handle_new_user()` to drop the now-dead seeded-profile branch (0 real "outreach-seeded" profiles exist today per root CLAUDE.md's own prior audit), then drop all three columns together.

---

## 7. `is_beta` (profiles — distinct from `accounts.is_beta`)

**Special case, as requested — which one does the app/RLS actually use:**
- **`profiles.is_beta`** is read by **sqrz-dashboard only**: `app/routes/_app.tsx:250`, `{!!p?.is_beta && (<span>Beta</span>)}` — renders a small "Beta" badge in the dashboard's top nav. `p` comes from `getCurrentProfile()` (`app/lib/profile.server.ts`), which does `.select("*")`, so this column rides along on every profile load regardless of whether the badge renders. No write path exists anywhere (not set by any migration, trigger, or app code found) — it's presumably hand-flipped in Supabase.
- **`accounts.is_beta`** is a **separate, newer (2026-10-24) column** added specifically to gate `campaign_templates` visibility: `caller_account_is_beta()` (SQL, `SECURITY DEFINER`) checks `accounts.is_beta = true` for `auth.uid()`, and the `campaign_templates_read` RLS policy calls it to show `visibility = 'beta'` templates to beta accounts. This is unrelated to the nav badge and does not touch `profiles.is_beta` at all.
- **sqrz-ios**: decodes `profiles.is_beta` as `var isBeta: Bool` (non-optional — see §Decode risk) with its own comment: *"decoded but currently unread anywhere in the app."* Confirmed by grep — no reader beyond the model declaration.
- **sqrz-profiles / sqrz-cast**: zero references to either column.

**Database references**: `profiles.is_beta` itself has zero function/trigger/view/RLS references (it's read in TypeScript app code only, via `select("*")`). `accounts.is_beta` is referenced by `caller_account_is_beta()` and the `campaign_templates_read` policy, but that's a different column on a different table.

**iOS decode risk**: **YES — non-optional.** `Models/Profile.swift:124`, `var isBeta: Bool` (not `Bool?`). sqrz-ios's `Profile` struct is decoded from explicit Supabase queries; if any query selects specific columns (rather than `*`) and omits `is_beta`, or if the column is dropped outright, decoding `Profile` fails entirely for every client build that still expects this field — including any older TestFlight build in the wild. Since nothing reads the decoded value, the field itself is otherwise dead weight on iOS.

**Current data**: 0/14 rows have `profiles.is_beta = true` (the dashboard badge currently shows for nobody).

**Recommendation**: **Drop `profiles.is_beta`, but iOS model cleanup must land first (or in the same release) to avoid stranding older TestFlight builds.** Order: (1) remove the Swift `isBeta` field + its `CodingKeys` case and ship that build, (2) remove the dashboard nav badge code, (3) drop the column once the iOS removal has had time to roll out past active TestFlight sessions. Do not touch `accounts.is_beta` — that's a live, different mechanism, out of scope for this cleanup.

---

## 8. `onboarding_completed`

**Code references**
- **sqrz-dashboard**: zero references anywhere in `app/` (confirmed by grep — no reads, no writes). The web `OnboardingModal` that used to write this was removed 2026-08-08 per this repo's CLAUDE.md, and nothing replaced it as a writer.
- **sqrz-ios**: zero references. **This contradicts the root CLAUDE.md's routing description** ("`.authenticated` → `OnboardingView` (if `!onboarding_completed`) or `MainTabView`") — that description is stale. sqrz-ios's *own* CLAUDE.md documents the real, current state: `OnboardingView.swift` and all onboarding routing were deleted outright on 2026-08-10 ("Removed onboarding entirely" — two passes, ending in full deletion), and `AuthManager.checkOnboardingStatus()` was replaced by `loadProfileFlags()`, which "no longer reads `onboarding_completed` at all." `RootView` today goes `.authenticated` → `MainTabView` directly, unconditionally. Confirmed via direct read of `sqrzApp.swift` and a full-repo grep for "onboarding" (zero `OnboardingView`-related files exist).
- **sqrz-profiles / sqrz-cast**: zero references.

**Database references**: the `profile_hubspot_enrichment` view selects `onboarding_completed`, but (same as `stripe_connect_status` above) the one consumer of that view, `hubspot-sync-contact`, never reads this field off the result. No function/trigger/RLS/cron references it.

**iOS decode risk**: none — not modeled in any current Swift struct (removed along with `OnboardingView`).

**Current data**: 6/14 rows `true`, 8/14 `false` — a real historical spread, but frozen; nothing currently writes or reads this value on any client.

**Recommendation**: **Drop.** Fully dead on every client as of today — flag for Will that the root `CLAUDE.md`'s routing description of this column/flow is stale and should be corrected (it still describes a deleted `OnboardingView` gate) independent of whether the column itself is dropped. `profile_hubspot_enrichment`'s view definition should drop this column in the same pass as `stripe_connect_status`/`grow_qualified` (see §2/§13 — same view, same "selected but discarded" pattern).

---

## 9. `availability_status`

**Code references**: only `delete-account` (nulls it on deletion) in sqrz-dashboard. Zero reads/writes anywhere else in any of the four repos.

**Database references**: none — no function, trigger, view, RLS policy, or cron job references it.

**iOS decode risk**: none.

**Current data**: 13/14 rows have it set (non-null) — frozen historical data, presumably from the long-gone availability/calendar feature (`availability_blocks` table, dropped 2026-07-31 per root CLAUDE.md's "No bookings, only leads" teardown).

**Recommendation**: **Drop.** Orphaned leftover from a fully-removed feature; only touched by the deletion scrub, which can drop its reference in the same pass.

---

## 10. `show_gig_history`

**Code references**
- **sqrz-ios**: decoded in `Models/Profile.swift:137` as `var showGigHistory: Bool?` — **optional**, no reader beyond the declaration (grepped `.showGigHistory` specifically — zero hits).
- **sqrz-dashboard / sqrz-profiles / sqrz-cast**: zero references. Confirms root CLAUDE.md's note that sqrz-profiles' `ProfileCalendar.tsx` (the only thing that ever consumed this toggle) was deleted once its own inputs (booking events/availability blocks) were dropped.

**Database references**: none.

**iOS decode risk**: **Low** — it's declared `Bool?` (optional), so dropping the column would decode to `nil` rather than failing. No functional risk either way since nothing reads the decoded value.

**Current data**: 0/14 rows `true`.

**Recommendation**: **Drop.** Zero live readers on any client; the one remaining reference is a dead decode target.

---

## 11. `grow_qualified`

**Code references**: zero reads anywhere in any of the four repos (sqrz-ios's `Profile.growQualified` field was removed outright 2026-07-29 per its own CLAUDE.md changelog — "decoded but never read; web dropped `grow_qualified` gating" — not just left dormant, actually deleted). No app writes it either.

**Database references**:
- **Live writer**: `auto_qualify_seeded_profile()` (trigger `on_claim_token_set`, see §4) sets `grow_qualified = true` whenever a `claim_token` is newly set on a row. Since nothing ever sets `claim_token` anymore (0 rows have one), this trigger path is currently dormant but still armed.
- `profile_hubspot_enrichment` view selects it; same "selected but discarded by the one consumer" situation as `onboarding_completed`/`stripe_connect_status` above.

**iOS decode risk**: none — field was deleted from the Swift model entirely (not just unread).

**Current data**: 1/14 rows `true` (a frozen historical value, presumably from before the claim-token mechanism stopped being exercised).

**Recommendation**: **Drop**, in the same migration as `claim_token` (§4) since its only writer is the trigger that fires off that column. Remove `on_claim_token_set`/`auto_qualify_seeded_profile()` and drop `grow_qualified` from `profile_hubspot_enrichment`'s view definition at the same time.

---

## 12. `is_demo`

**Code references**: zero references in any of the four repos — confirmed by grep for both `is_demo`/`isDemo` with word boundaries. sqrz-ios's own CLAUDE.md describes `AuthManager.loadProfileFlags()` as loading "the `is_demo` flag it always also loaded (which gates write actions app-wide)" and several historical changelog entries reference a `demoBlockAlert`/demo-gating pattern in `WalletView` — **none of this exists in the current codebase**. Grepped for `demoBlockAlert`, `isDemoAccount`, and literal `"demo"` comparisons: zero hits. The `Features/Shared/DemoBanner.swift` file referenced in the CLAUDE.md project-structure tree also appears to have no live gating tied to this column today. This looks like stale documentation describing a mechanism that was later removed without a changelog entry (the memory note "demo mode retirement" in this user's own notes — "sqrz-ios demo mode to be removed from public app later" — suggests demo-mode is a planned/evolving concept, not necessarily this exact column).

**Database references**: none — no function, trigger, view, RLS, or cron job references `is_demo`.

**iOS decode risk**: none — not modeled in any current Swift struct.

**Current data**: 0/14 rows `true`.

**Recommendation**: **Drop.** No live reader or writer found anywhere, at any layer, despite CLAUDE.md's description of it as an active app-wide gate — flagged for Will before dropping. **Confirmed 2026-11-02**: Will included it in the drop list. Included in `20261102_drop_dead_profile_columns.sql`.

---

## 13. `is_partner`

**Special case, as requested — usages only, no move-to-account-level plan:**

**Code references**
- **sqrz-dashboard**: **actively used.** `supabase/functions/get-or-create-invite-code/index.ts` reads `profiles.is_partner` and returns `403 not_a_partner` if false — this gates creation/retrieval of a partner's ongoing invite code (`invite_codes` table — a newer mechanism than the `referral_codes`/`referral_uses` system root CLAUDE.md describes as dropped). The old web nav branch (`_app.tsx`'s `isPartner`-driven 4th-nav-slot logic, and the `/partners`/`/partner-onboarding` redirect stubs) is **fully gone now** — `_app.tsx:79-83` shows the ternary was "actually removed (not hardcoded false)" per its own comment, and `ls app/routes/ | grep partner` returns nothing: those redirect stubs root CLAUDE.md describes as "kept alive, repointed to `/office`" have since been deleted outright. (A same-named `referral_codes.is_partner` column also exists and is read by `create_booking_request()`'s referral-attribution subquery — that's a different table, unrelated to `profiles.is_partner`; flagging so it isn't conflated.)
- **sqrz-ios**: **actively used.** `Models/Profile.swift:114`, `var isPartner: Bool` (non-optional). Consumers: `Core/IAP/InviteCodeService.swift` (calls the `get-or-create-invite-code`/`redeem-invite-code` edge functions, doc comment: *"`is_partner`-gated server-side — throws `.notAPartner` if the caller isn't"*), `Features/Account/ProfileSwitcherSheet.swift` (gates some UI on "the PRIMARY profile's `is_partner`, independent of which [profile is active]" — `store.profiles.first?.isPartner == true`), and `Features/Grow/GrowTabView.swift` has a comment noting a prior tab-visibility exception for Invites was gated on `is_partner` (that specific Invites tab was removed 2026-08-16 per sqrz-ios's own CLAUDE.md, but the field and the invite-code gating above are current, not historical).
- **sqrz-profiles / sqrz-cast**: zero references.

**Database references**: `get-or-create-invite-code` is the only DB-adjacent consumer (an edge function, not a DB function/trigger/view/RLS policy — confirmed no `pg_proc`/`pg_policies` hits for `profiles.is_partner` specifically). `redeem-invite-code` (the companion redemption-side function) does not itself reference `is_partner`.

**iOS decode risk**: **YES — non-optional.** Same risk class as `is_beta` (§7): `var isPartner: Bool`, not `Bool?`. Unlike `is_beta`, this field has live readers today, so it is **not** a drop candidate regardless of decode risk.

**Current data**: 1/14 rows `true`.

**Recommendation**: **Keep.** This is a live, actively-read-and-enforced entitlement flag (a real 403 gate in a deployed edge function, consumed by real iOS UI) — not a cleanup candidate at all. Flagging only the usages as requested; no move-to-account-level plan here.

---

## Summary table

| Column | Code refs (live) | DB refs (live) | iOS decode risk | Non-default rows | Recommendation |
|---|---|---|---|---|---|
| `stripe_connect_id` | sqrz-profiles checkout route | none | none | 1/14 | Drop (remove checkout route's dependency first) |
| `stripe_connect_id_test` | none (scrub only) | none | none | 1/14 | Drop |
| `stripe_connect_status` | sqrz-profiles checkout route | `profile_hubspot_enrichment` view (unused by consumer) | none | 13/14 set, 0 active | Drop (view + checkout route first) |
| `stripe_connect_status_test` | none (scrub only) | none | none | 1/14 | Drop |
| `stripe_beta_test_mode` | **yes** — wallet topup + budget checkout mode switch | none | none | 0/14 true | **Keep** |
| `claim_token` | none (scrub only) | `handle_new_user`, 2 triggers | none | 0/14 | Drop (triggers first) |
| `claimed_at` | none | none | none | 2/14 | Drop |
| `is_claimed` | none (scrub sets true) | `handle_new_user`, 2 triggers | none | 14/14 true | Drop (with claim_token cleanup) |
| `is_beta` (profiles) | dashboard nav badge | none | **yes**, non-optional | 0/14 | Drop (iOS field removal first) |
| `onboarding_completed` | none (stale CLAUDE.md claim) | `profile_hubspot_enrichment` view (unused) | none | 6/14 true | Drop |
| `availability_status` | none (scrub only) | none | none | 13/14 | Drop |
| `show_gig_history` | none | none | low, optional | 0/14 | Drop |
| `grow_qualified` | none | 1 trigger (dormant), 1 view (unused) | none | 1/14 | Drop (with claim_token cleanup) |
| `is_demo` | none found (contradicts CLAUDE.md) | none | none | 0/14 | Drop — confirmed with Will 2026-11-02 |
| `is_partner` | **yes** — invite-code gate, iOS UI | edge function only | **yes**, non-optional | 1/14 | **Keep** |

**Net**: 13 of 15 columns are genuine drop candidates (12 plus `is_demo`, confirmed with Will on 2026-11-02 despite its contradiction with an existing documentation claim); 2 (`stripe_beta_test_mode`, `is_partner`) are live and stay. `is_beta`'s non-optional Swift field was removed from `Models/Profile.swift` ahead of the schema drop (see "Execution" above) — `is_partner`'s non-optional field stays, since that column isn't being dropped. The `profile_hubspot_enrichment` view and the `claim_token`/`grow_qualified` triggers are rewritten/dropped in `20261102_drop_dead_profile_columns.sql`, in the same migration as their respective columns, per this audit's own recommendation.
