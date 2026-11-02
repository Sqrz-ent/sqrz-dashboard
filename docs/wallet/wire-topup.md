# Wallet top-up by bank transfer (USD + EUR)

Status: built 2026-11-10 — **code and migration only, nothing applied or deployed.** Off by default.

Bank transfer is offered next to the card (Stripe) top-up as the cheaper, recommended option ("Bank transfer — no card fees", with a **Save $X** badge). Will credits the wallet **manually** once the money arrives.

## How it works

1. **User** opens Top up (iOS account sheet or web header popover), types an amount (the ad budget = what the wallet will be credited, in USD), picks **Bank transfer**. If more than one currency is set up they pick USD or EUR.
2. The app calls the edge function **`wire-topup-create`**. It checks the switch, min/max, an active bank account for the currency, the open-transfer cap, then creates a `wire_topups` row (`status = pending`) with a unique **reference code** (`SQRZ-7F3K`), the fee, the exact amount to send and the expiry.
3. The app shows **bank details, exact amount and reference code** (each with a Copy button), the expiry date, and "credited after the funds arrive — usually 1–3 business days". The transfer also appears in the account sheet / web popover under **Bank transfers** with its status, and can be reopened.
4. The user pays from their bank, putting the reference in the payment description.
5. **Will** sees it in the iOS **Sandbox sheet → Bank transfers** (pending first), enters the amount that actually arrived and taps **Mark received**. The edge function **`wire-topup-admin`** runs `credit_wire_topup`, which credits the wallet through **`record_wallet_topup` — the same function the Stripe webhook uses** (ledger entry, `management_fee_charges` row, balance trigger), links `ledger_entry_id`, and notifies the user ("Bank transfer received — $100 added to your wallet", push + in-app).
6. A transfer can be credited **once** (idempotent: a repeat call returns "already credited"; the ledger insert is also keyed on `wire:<id>`).

## Fees and the saving

The user pays `amount + fee` where `fee = amount × wire_fee_pct`. The wallet is credited the full `amount`; the fee is recorded as a `management_fee_charges` row (same table as the card fee). The **Save $X** figure is the card fee (7%, see below) minus the wire fee on the same amount. Example at `wire_fee_pct = 2`: $100 → card fee $7.00, wire fee $2.00, **save $5.00**.

The card fee is still hardcoded at 7% in `app/lib/walletPayments.server.ts`, `record_wallet_topup` and the iOS card; the edge function has the same constant (`CARD_TOPUP_FEE_PCT` in `supabase/functions/_shared/wire.ts`) **only to show the saving**. Card config was left as is — if the card rate ever changes, update that constant too.

## Where Will configures things

| What | Where | Notes |
|---|---|---|
| **Bank details** | Supabase Table Editor → `wire_accounts` (one row per currency: `USD`, `EUR`) | Seeded **empty**. Fill `account_holder`, `bank_name`, `account_number` (**IBAN for EUR**), `routing_number` (ABA, USD), `swift_bic`, `bank_address`, `notes`, then set `is_active = true`. **Every column is shown to signed-in users**, including `notes`. |
| Switch | `app_config` → `wire_topup_enabled` (`false`) | Turn on last. The option also stays hidden unless at least one currency has an active bank row (and, for EUR, a rate). |
| Min / max | `wire_topup_min_cents` (5000 = $50), `wire_topup_max_cents` (500000 = $5,000) | In USD cents = the wallet credit. |
| Fee | `wire_fee_pct` (default `2`) | **Placeholder — set the real rate before enabling.** |
| Expiry | `wire_expiry_days` (default `7`) | |
| Open transfers per account | `wire_topup_max_pending` (default `3`) | Extra limit (not in the original list). |
| EUR rate | `wire_fx_rates` (`{"USD": 1, "EUR": 0}`) | USD per 1 EUR. **`0` = EUR not configured → EUR hidden/refused.** Extra key. Set it to the rate you're willing to quote (it is snapshotted per request). |

All are plain `app_config` rows (`key`, `value` jsonb), editable in the Table Editor; the edge functions read them on every call, so changes apply immediately. Existing open transfers keep the fee and rate they were quoted.

**EUR:** the wallet is USD. The user chooses the *USD* amount to credit and is shown the EUR to send: `ceil((amount + fee) ÷ rate)`.

## Manual crediting — steps for Will

1. Check your bank for a payment carrying a `SQRZ-XXXX` reference.
2. iOS: account sheet → **Sandbox** → **Bank transfers**. Find the row with that reference (the profile name is shown).
3. Type the amount that **actually arrived** in the transfer's currency (**Use expected** fills the quoted amount) → **Mark received** → confirm.
4. The row shows "Credited $…"; the user gets a notification. Done.

Rules the server applies:
- Received **equals** the quote → credits exactly the quoted amount and fee.
- Received **differs** (bank charges, short/over payment) → credits **pro rata**: the money received, converted to USD at the quoted rate, split in the quoted amount:fee ratio. The wallet always matches the money that arrived. Check the row's "credited" figure afterwards.
- A figure more than 10× the expected amount is rejected (typo guard — the field is in currency units, the API in cents).
- **Late money still works:** `pending` and `expired` transfers can be credited. A `cancelled` one cannot (create a new one).
- **Cancel** is for requests you know won't be paid; it is refused once a transfer is credited.
- Pending rows past `expires_at` show as **Expired** everywhere (the Sandbox list also flips the stored status).

## Pieces

| Piece | File |
|---|---|
| Tables, config keys, notification type, `record_wallet_topup` fee override, `credit_wire_topup` | `supabase/migrations/20261110120000_wire_topups.sql` |
| User edge function (`options`, `create`) | `supabase/functions/wire-topup-create/index.ts` |
| Admin edge function (`list`, `mark_received`, `cancel`; `is_lab` check like `sandbox-admin`) | `supabase/functions/wire-topup-admin/index.ts` |
| Shared config / fee / reference-code helpers | `supabase/functions/_shared/wire.ts` |
| Web: resource route + UI | `app/routes/api.wire-topup.tsx`, `app/components/WireTopupPanel.tsx`, `app/components/ProfileSwitcher.tsx` |
| Notification copy (`wire_topup_received`) | `app/components/NotificationList.tsx`, `supabase/functions/apns-push/index.ts`, sqrz-ios `AppNotification.swift` |
| iOS | `Features/Wallet/WireTopupService.swift`, `WireTopupViews.swift`, `WalletTopupCard.swift`, `Features/Account/ProfileSwitcherSheet.swift`, `Features/Sandbox/WireTransfersAdminSection.swift`, `SandboxSheet.swift` |

## Security

- `wire_topups`: RLS on; account owners can **read** their rows; **no** client write policies (insert/update/delete revoked) — all writes via the edge functions (service role).
- `wire_accounts`: RLS on; signed-in users can read **active** rows only; no client writes.
- `credit_wire_topup` and the new `record_wallet_topup` are executable by `service_role` only.
- `wire-topup-admin`: JWT verified by the platform, then `caller_account_is_lab()` with the caller's own JWT → 403 otherwise. (As with `sandbox-admin`: anyone with `accounts.is_lab` can credit wallets — switch to a dedicated admin flag before adding external Lab testers.)

## Rollout (nothing is applied yet)

1. Review and apply `20261110120000_wire_topups.sql`. (It drops and recreates `record_wallet_topup` with an extra optional `p_fee_cents` parameter; the Stripe webhook's call is unaffected — default behaviour is the same 7%.)
2. Deploy `wire-topup-create`, `wire-topup-admin` (**with** JWT verification, like `sandbox-admin`) and `apns-push` (new notification copy).
3. Fill `wire_accounts`, set `wire_fee_pct` (and `wire_fx_rates.EUR` if using EUR), then set `wire_topup_enabled = true`.
4. Deploy the dashboard; ship the iOS build (older iOS builds simply don't show the option; an unknown notification type falls back to a generic line there).
5. Smoke test with a small transfer to yourself: create → pay → Mark received → check the wallet, the `management_fee_charges` row and the notification.

Not compiled/run in the session that wrote it: the iOS code (no Xcode), the SQL (not applied) and the edge functions (no Deno) — `npm run typecheck`/`build` pass for the web part.
