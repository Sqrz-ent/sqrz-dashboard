import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  adminClient, bearer, CARD_TOPUP_FEE_PCT, feeCents, generateReferenceCode, json, loadWireConfig,
  SUPPORTED_CURRENCIES, transferAmountCents,
} from "../_shared/wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// wire-topup-create — a signed-in user asks to top up their ad-spend wallet by BANK TRANSFER.
// Normal JWT verification (deploy WITHOUT --no-verify-jwt); the user is re-checked with getUser().
// All writes use the service role — wire_topups has no client write policies.
//
// POST { action: "options" }
//   → { enabled, min_cents, max_cents, fee_pct, card_fee_pct, expiry_days, currencies: [{currency, fx_rate}] }
//     (only currencies that have an ACTIVE wire_accounts row and a valid FX rate)
// POST { action: "create", currency: "USD"|"EUR", amount_cents, profile_id?, source?: "web"|"ios" }
//   amount_cents = what the WALLET is credited, in USD cents. The user sends amount + fee (converted at
//   the configured rate for EUR).
//   → { transfer: { id, reference_code, currency, amount_cents, fee_cents, transfer_amount_cents,
//                   fx_rate, expires_at, status }, bank: { ...wire_accounts row (user-visible cols) },
//       card_comparison: { card_fee_cents, wire_fee_cents, savings_cents } }
//   Errors: { error, code } — wire_disabled 403 · invalid_amount / below_min / above_max /
//   currency_unavailable 400 · too_many_pending 429.
// Config (app_config wire_*): wire_topup_enabled, _min_cents, _max_cents, wire_fee_pct, wire_expiry_days,
// wire_topup_max_pending, wire_fx_rates.
// ─────────────────────────────────────────────────────────────────────────────

const err = (error: string, code: string, status: number) => json({ error, code }, status);

Deno.serve(async (req) => {
  if (req.method !== "POST") return err("Method not allowed", "method_not_allowed", 405);

  const admin = adminClient();
  const jwt = bearer(req);
  if (!jwt) return err("Unauthorized", "unauthorized", 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user) return err("Unauthorized", "unauthorized", 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return err("Invalid JSON body", "bad_request", 400); }
  const action = String(body.action ?? "");

  const cfg = await loadWireConfig(admin);

  // Currencies the user can actually pick: active bank account + a usable rate.
  const { data: accounts } = await admin.from("wire_accounts").select("*").eq("is_active", true);
  const activeAccounts = (accounts ?? []) as Array<Record<string, unknown>>;
  const available = SUPPORTED_CURRENCIES.filter((c) =>
    activeAccounts.some((a) => a.currency === c) && (cfg.fxRates[c] ?? 0) > 0
  );

  if (action === "options") {
    return json({
      enabled: cfg.enabled && available.length > 0,
      min_cents: cfg.minCents,
      max_cents: cfg.maxCents,
      fee_pct: cfg.feePct,
      card_fee_pct: CARD_TOPUP_FEE_PCT,
      expiry_days: cfg.expiryDays,
      currencies: available.map((c) => ({ currency: c, fx_rate: cfg.fxRates[c] })),
    });
  }

  if (action !== "create") return err("action must be one of: options, create", "bad_request", 400);

  if (!cfg.enabled) return err("Bank transfers are not available right now.", "wire_disabled", 403);

  const currency = String(body.currency ?? "").toUpperCase();
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency) || !available.includes(currency as "USD" | "EUR")) {
    return err("That currency isn't available for bank transfers right now.", "currency_unavailable", 400);
  }
  const bank = activeAccounts.find((a) => a.currency === currency)!;

  const amount = Number(body.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) return err("amount_cents must be a positive integer.", "invalid_amount", 400);
  if (amount < cfg.minCents) return err(`Minimum bank transfer top-up is ${(cfg.minCents / 100).toFixed(2)} USD.`, "below_min", 400);
  if (amount > cfg.maxCents) return err(`Maximum bank transfer top-up is ${(cfg.maxCents / 100).toFixed(2)} USD.`, "above_max", 400);

  // Resolve the account (must be this user's) and the profile the request is made from.
  const { data: account } = await admin.from("accounts").select("id").eq("user_id", user.id).maybeSingle();
  if (!account) return err("Account not found.", "no_account", 404);
  const requestedProfileId = typeof body.profile_id === "string" ? body.profile_id : null;
  let profileQuery = admin.from("profiles").select("id").eq("account_id", account.id as string);
  profileQuery = requestedProfileId
    ? profileQuery.eq("id", requestedProfileId)
    : profileQuery.order("created_at", { ascending: true }).limit(1);
  const { data: profileRows } = await profileQuery;
  const profileId = (profileRows ?? [])[0]?.id as string | undefined;
  if (!profileId) return err("Profile not found for this account.", "no_profile", 404);

  // Cap open transfers per account (pending and not yet expired).
  const { count: openCount } = await admin.from("wire_topups").select("id", { count: "exact", head: true })
    .eq("account_id", account.id as string).eq("status", "pending").gt("expires_at", new Date().toISOString());
  if ((openCount ?? 0) >= cfg.maxPending) {
    return err("You already have open bank transfers waiting. Complete or wait for them to expire first.", "too_many_pending", 429);
  }

  const fx = cfg.fxRates[currency];
  const fee = feeCents(amount, cfg.feePct);
  const transferCents = transferAmountCents(amount, fee, fx);
  const expiresAt = new Date(Date.now() + cfg.expiryDays * 86_400_000).toISOString();
  const source = body.source === "ios" ? "ios" : "web";

  // Reference code: random, retried on the (rare) unique collision.
  let row: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 6 && !row; attempt++) {
    const { data, error } = await admin.from("wire_topups").insert({
      account_id: account.id,
      profile_id: profileId,
      requested_by: user.id,
      source,
      currency,
      amount_cents: amount,
      fee_cents: fee,
      fee_pct: cfg.feePct,
      fx_rate: fx,
      transfer_amount_cents: transferCents,
      reference_code: generateReferenceCode(),
      expires_at: expiresAt,
    }).select("id, reference_code, currency, amount_cents, fee_cents, transfer_amount_cents, fx_rate, expires_at, status").single();
    if (!error && data) { row = data; break; }
    if (error && error.code !== "23505") {
      console.error("[wire-topup-create] insert failed:", error.message);
      return err("Couldn't create the transfer. Please try again.", "insert_failed", 500);
    }
  }
  if (!row) return err("Couldn't create the transfer. Please try again.", "insert_failed", 500);

  const cardFee = feeCents(amount, CARD_TOPUP_FEE_PCT);
  return json({
    transfer: row,
    bank: {
      currency: bank.currency,
      account_holder: bank.account_holder,
      bank_name: bank.bank_name,
      account_number: bank.account_number,
      routing_number: bank.routing_number ?? null,
      swift_bic: bank.swift_bic ?? null,
      bank_address: bank.bank_address ?? null,
      notes: bank.notes ?? null,
    },
    card_comparison: { card_fee_cents: cardFee, wire_fee_cents: fee, savings_cents: Math.max(0, cardFee - fee) },
  });
});
