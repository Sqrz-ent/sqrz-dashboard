// Shared helpers for the bank-transfer (wire) wallet top-up edge functions
// (wire-topup-create, wire-topup-admin). See docs/wallet/wire-topup.md.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SUPPORTED_CURRENCIES = ["USD", "EUR"] as const;
export type WireCurrency = typeof SUPPORTED_CURRENCIES[number];

// The CARD top-up fee, used ONLY to show "you save $X vs paying by card". The real card fee lives in
// three other places that must all say the same thing: app/lib/walletPayments.server.ts
// (SQRZ_TOPUP_FEE_PCT, what Stripe charges), record_wallet_topup (DB, what is booked as revenue) and
// sqrz-ios WalletTopupCard.topupFeePct (what the app displays). Not configurable today.
export const CARD_TOPUP_FEE_PCT = 7;

export type WireConfig = {
  enabled: boolean;
  minCents: number;
  maxCents: number;
  feePct: number;
  expiryDays: number;
  maxPending: number;
  fxRates: Record<string, number>;
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

// Reads the wire_* keys from app_config. Defensive: a missing/garbled value falls back to the SAFE
// default (feature off, conservative limits) rather than throwing.
export async function loadWireConfig(admin: SupabaseClient): Promise<WireConfig> {
  const { data } = await admin.from("app_config").select("key, value").like("key", "wire_%");
  const m = new Map<string, unknown>((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  const fxRaw = m.get("wire_fx_rates");
  const fxRates: Record<string, number> = {};
  if (fxRaw && typeof fxRaw === "object") {
    for (const [k, v] of Object.entries(fxRaw as Record<string, unknown>)) fxRates[k.toUpperCase()] = num(v, 0);
  }
  fxRates["USD"] = 1;
  return {
    enabled: m.get("wire_topup_enabled") === true,
    minCents: Math.max(1, Math.round(num(m.get("wire_topup_min_cents"), 5000))),
    maxCents: Math.max(1, Math.round(num(m.get("wire_topup_max_cents"), 500000))),
    feePct: Math.max(0, num(m.get("wire_fee_pct"), 2)),
    expiryDays: Math.max(1, Math.round(num(m.get("wire_expiry_days"), 7))),
    maxPending: Math.max(1, Math.round(num(m.get("wire_topup_max_pending"), 3))),
    fxRates,
  };
}

export const feeCents = (amountCents: number, pct: number): number => Math.round(amountCents * (pct / 100));

// What the user must send, in the transfer currency: (credit + fee) ÷ fx, rounded UP so we never
// receive less than quoted. fx = USD per 1 unit of the currency (USD = 1).
export function transferAmountCents(amountCents: number, fee: number, fx: number): number {
  return Math.ceil((amountCents + fee) / fx);
}

// Unambiguous alphabet: no 0/O, 1/I, L. Code looks like SQRZ-7F3K.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function generateReferenceCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return "SQRZ-" + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function bearer(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}
