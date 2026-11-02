import { useState } from "react";

// Bank-transfer option of the web Top up popover (docs/wallet/wire-topup.md). Pure UI: all logic is
// server-side (wire-topup-create via /api/wire-topup). The amount field lives in ProfileSwitcher and is
// passed in as `amountCents` (the wallet credit, USD cents).
//
// Non-committal until explicitly confirmed (2026-11): "Show bank details" only requests a QUOTE
// (nothing written server-side) — the form → QuotePreview ("Nothing is booked yet.", Back / "I'll
// send this transfer") → Instructions (reference code assigned) flow. Only "I'll send this transfer"
// actually creates the wire_topups row. Pending transfers in the list below can be cancelled before
// money is sent; the list itself only ever shows pending rows and recently-received ones (filtered
// server-side, in app/routes/api.wire-topup.tsx).

export type WireOptions = {
  enabled: boolean;
  min_cents: number;
  max_cents: number;
  fee_pct: number;
  card_fee_pct: number;
  expiry_days: number;
  currencies: { currency: "USD" | "EUR"; fx_rate: number }[];
};

export type WireBank = {
  currency: string;
  account_holder: string;
  bank_name: string;
  account_number: string;
  routing_number: string | null;
  swift_bic: string | null;
  bank_address: string | null;
  notes: string | null;
};

export type WireTransferRow = {
  id: string;
  reference_code: string;
  currency: string;
  amount_cents: number;
  fee_cents: number;
  transfer_amount_cents: number;
  status: string;
  expires_at: string;
  created_at: string;
  received_at?: string | null;
};

const ACCENT = "#F5A623";
const GREEN = "#22c55e";

export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--text-muted)" };
const small: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 };

// Exported so server-side code (app/routes/api.wire-topup.tsx) can reuse the same "is this row still
// pending, or has its expiry just not been flipped in the DB yet" logic when deciding what to show.
export function effectiveStatus(t: WireTransferRow): "pending" | "expired" | "received" | "cancelled" {
  if (t.status === "pending" && new Date(t.expires_at).getTime() < Date.now()) return "expired";
  return t.status as "pending" | "received" | "cancelled" | "expired";
}

function CopyRow({ name, value, strong }: { name: string; value: string; strong?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{name}</div>
        <div style={{ fontSize: strong ? 15 : 13, fontWeight: strong ? 800 : 600, color: "var(--text)", wordBreak: "break-all" }}>{value}</div>
      </div>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 8px", fontSize: 11, fontWeight: 600, color: copied ? GREEN : "var(--text)", cursor: "pointer", flexShrink: 0 }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export type WireInstructions = {
  transfer: WireTransferRow;
  bank: WireBank | null;
};

function Instructions({ data, onBack }: { data: WireInstructions; onBack: () => void }) {
  const { transfer: t, bank } = data;
  const exact = money(t.transfer_amount_cents, t.currency);
  const expired = effectiveStatus(t) === "expired";
  return (
    <div>
      <button type="button" onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 0, marginBottom: 8 }}>
        ← Back
      </button>
      <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 800, color: "var(--text)" }}>Send exactly {exact}</p>
      <p style={{ ...small, margin: "0 0 10px" }}>
        {money(t.amount_cents, "USD")} ad budget{t.fee_cents > 0 ? ` + ${money(t.fee_cents, "USD")} fee` : ""}
        {t.currency !== "USD" ? ` (converted to ${t.currency})` : ""}.
      </p>
      <CopyRow name="Payment reference — required" value={t.reference_code} strong />
      <p style={{ ...small, margin: "4px 0 10px" }}>Include this reference in your transfer.</p>
      <CopyRow name="Amount" value={(t.transfer_amount_cents / 100).toFixed(2)} />
      {bank && (
        <>
          <CopyRow name="Account holder" value={bank.account_holder} />
          <CopyRow name="Bank" value={bank.bank_name} />
          <CopyRow name={t.currency === "EUR" ? "IBAN" : "Account number"} value={bank.account_number} />
          {bank.routing_number && <CopyRow name="Routing number (ABA)" value={bank.routing_number} />}
          {bank.swift_bic && <CopyRow name="SWIFT / BIC" value={bank.swift_bic} />}
          {bank.bank_address && <CopyRow name="Bank address" value={bank.bank_address} />}
          {bank.notes && <p style={{ ...small, margin: "8px 0 0" }}>{bank.notes}</p>}
        </>
      )}
      <p style={{ ...small, margin: "10px 0 0" }}>
        Put the reference in the payment description so we can match your transfer. Funds are credited after they arrive — usually 1–3 business days.{" "}
        {expired ? (
          <strong style={{ color: "#ef4444" }}>This request has expired; if you already paid, it will still be credited once it arrives.</strong>
        ) : (
          <>Open until {new Date(t.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.</>
        )}
      </p>
    </div>
  );
}

// Non-committal preview — the response shape of wire-topup-create's "quote" action. No reference
// code, no expiry, no row: nothing is created until the user explicitly confirms.
export type WireQuote = {
  amount_cents: number;
  fee_cents: number;
  fee_pct: number;
  currency: string;
  fx_rate: number;
  transfer_amount_cents: number;
  bank: WireBank | null;
};

function QuotePreview({
  quote,
  onBack,
  onConfirm,
  submitting,
  error,
}: {
  quote: WireQuote;
  onBack: () => void;
  onConfirm: () => void;
  submitting: boolean;
  error: string;
}) {
  const bank = quote.bank;
  const exact = money(quote.transfer_amount_cents, quote.currency);
  return (
    <div>
      <button type="button" onClick={onBack} disabled={submitting} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: submitting ? "default" : "pointer", fontSize: 12, padding: 0, marginBottom: 8 }}>
        ← Back
      </button>
      <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 800, color: "var(--text)" }}>Send exactly {exact}</p>
      <div style={{ marginBottom: 10, fontSize: 12, color: "var(--text-muted)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Ad budget</span>
          <span>{money(quote.amount_cents, "USD")}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span>Bank transfer fee ({quote.fee_pct}%)</span>
          <span>{money(quote.fee_cents, "USD")}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid var(--border)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
          <span>You send</span>
          <span>{exact}</span>
        </div>
      </div>
      {bank && (
        <>
          <CopyRow name="Account holder" value={bank.account_holder} />
          <CopyRow name="Bank" value={bank.bank_name} />
          <CopyRow name={quote.currency === "EUR" ? "IBAN" : "Account number"} value={bank.account_number} />
          {bank.routing_number && <CopyRow name="Routing number (ABA)" value={bank.routing_number} />}
          {bank.swift_bic && <CopyRow name="SWIFT / BIC" value={bank.swift_bic} />}
          {bank.bank_address && <CopyRow name="Bank address" value={bank.bank_address} />}
          {bank.notes && <p style={{ ...small, margin: "8px 0 0" }}>{bank.notes}</p>}
        </>
      )}
      <p style={{ margin: "10px 0 12px", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Nothing is booked yet.</p>
      {error && <p role="alert" style={{ margin: "0 0 10px", fontSize: 12, color: "#ef4444" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          style={{ flex: 1, background: "transparent", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, fontSize: 14, fontWeight: 700, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.6 : 1 }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting}
          style={{ flex: 2, background: ACCENT, color: "#111", border: "none", borderRadius: 10, padding: 12, fontSize: 14, fontWeight: 700, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.6 : 1 }}
        >
          {submitting ? "Creating…" : "I'll send this transfer"}
        </button>
      </div>
    </div>
  );
}

export default function WireTopupPanel({
  options,
  banks,
  transfers,
  amountCents,
  profileId,
  onCreated,
}: {
  options: WireOptions;
  banks: WireBank[];
  transfers: WireTransferRow[];
  amountCents: number | null;
  profileId: string;
  // Called after any mutation that should refresh the account's wire state (a transfer was created
  // OR cancelled) — the name predates cancel support but the parent (ProfileSwitcher) just reloads
  // the same /api/wire-topup data either way, so one callback still covers both.
  onCreated: () => void;
}) {
  const [currency, setCurrency] = useState<"USD" | "EUR">(options.currencies[0]?.currency ?? "USD");
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [quote, setQuote] = useState<WireQuote | null>(null);
  const [view, setView] = useState<WireInstructions | null>(null);

  const fx = options.currencies.find((c) => c.currency === currency)?.fx_rate ?? 1;

  if (view) return <Instructions data={view} onBack={() => setView(null)} />;

  const inRange = amountCents != null && amountCents >= options.min_cents && amountCents <= options.max_cents;
  const fee = amountCents != null ? Math.round(amountCents * (options.fee_pct / 100)) : 0;
  const cardFee = amountCents != null ? Math.round(amountCents * (options.card_fee_pct / 100)) : 0;
  const saving = Math.max(0, cardFee - fee);
  const sendCents = amountCents != null ? Math.ceil((amountCents + fee) / fx) : 0;

  // "Show bank details" — non-committal preview, writes nothing server-side.
  async function requestQuote() {
    if (!inRange || amountCents == null || quoting) return;
    setQuoting(true);
    setError("");
    try {
      const res = await fetch(`/api/wire-topup?profile_id=${encodeURIComponent(profileId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quote", currency, amount_cents: amountCents }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.error ?? "Couldn't load the bank details. Please try again.");
      setQuote(data as WireQuote);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the bank details. Please try again.");
    } finally {
      setQuoting(false);
    }
  }

  // "I'll send this transfer" — the explicit, committing step. Only reachable from the quote view.
  async function create() {
    if (!inRange || amountCents == null || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/wire-topup?profile_id=${encodeURIComponent(profileId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", currency, amount_cents: amountCents }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.transfer) throw new Error(data?.error ?? "Couldn't create the transfer. Please try again.");
      setQuote(null);
      setView({ transfer: data.transfer as WireTransferRow, bank: data.bank as WireBank });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the transfer. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id: string) {
    if (cancellingId) return;
    setCancellingId(id);
    setError("");
    try {
      const res = await fetch(`/api/wire-topup?profile_id=${encodeURIComponent(profileId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", wire_topup_id: id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Couldn't cancel the transfer. Please try again.");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cancel the transfer. Please try again.");
    } finally {
      setCancellingId(null);
    }
  }

  if (quote) {
    return (
      <QuotePreview
        quote={quote}
        onBack={() => {
          setQuote(null);
          setError("");
        }}
        onConfirm={create}
        submitting={submitting}
        error={error}
      />
    );
  }

  return (
    <div>
      {options.currencies.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {options.currencies.map((c) => (
            <button
              key={c.currency}
              type="button"
              onClick={() => setCurrency(c.currency)}
              style={{
                flex: 1,
                padding: "6px 0",
                borderRadius: 8,
                border: `1px solid ${currency === c.currency ? ACCENT : "var(--border)"}`,
                background: currency === c.currency ? "rgba(245,166,35,0.12)" : "transparent",
                color: "var(--text)",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Pay in {c.currency}
            </button>
          ))}
        </div>
      )}

      {amountCents != null && inRange && (
        <div style={{ marginBottom: 10, fontSize: 12, color: "var(--text-muted)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>Ad budget</span>
            <span>{money(amountCents, "USD")}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span>Bank transfer fee ({options.fee_pct}%)</span>
            <span>{money(fee, "USD")}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid var(--border)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            <span>You send</span>
            <span>{money(sendCents, currency)}</span>
          </div>
          {saving > 0 && (
            <div style={{ marginTop: 8, display: "inline-block", background: "rgba(34,197,94,0.14)", color: GREEN, fontWeight: 800, fontSize: 12, padding: "3px 10px", borderRadius: 999 }}>
              Save {money(saving, "USD")} vs card
            </div>
          )}
        </div>
      )}

      <p style={{ ...small, margin: "0 0 10px" }}>
        Minimum {money(options.min_cents, "USD")}, maximum {money(options.max_cents, "USD")}. No card fees — only a {options.fee_pct}% transfer fee. Your wallet is credited after the money arrives (usually 1–3 business days).
      </p>

      {error && <p role="alert" style={{ margin: "0 0 10px", fontSize: 12, color: "#ef4444" }}>{error}</p>}

      <button
        type="button"
        onClick={requestQuote}
        disabled={!inRange || quoting}
        style={{
          width: "100%",
          background: ACCENT,
          color: "#111",
          border: "none",
          borderRadius: 10,
          padding: 12,
          fontSize: 14,
          fontWeight: 700,
          cursor: !inRange || quoting ? "default" : "pointer",
          opacity: !inRange || quoting ? 0.5 : 1,
        }}
      >
        {quoting ? "Loading…" : "Show bank details →"}
      </button>

      {transfers.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <p style={{ ...label, margin: "0 0 6px" }}>Your bank transfers</p>
          {transfers.map((t) => {
            const st = effectiveStatus(t);
            const bank = banks.find((b) => b.currency === t.currency) ?? null;
            const color = st === "received" ? GREEN : st === "expired" ? "var(--text-muted)" : ACCENT;
            return (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
                <button
                  type="button"
                  onClick={() => setView({ transfer: t, bank })}
                  style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, textAlign: "left", background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--text)" }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>{money(t.amount_cents, "USD")} · {t.reference_code}</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                      {new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: "capitalize" }}>{st}</span>
                </button>
                {st === "pending" && (
                  <button
                    type="button"
                    onClick={() => cancel(t.id)}
                    disabled={cancellingId === t.id}
                    style={{ flexShrink: 0, background: "transparent", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 8px", fontSize: 11, fontWeight: 600, color: cancellingId === t.id ? "var(--text-muted)" : "#ef4444", cursor: cancellingId === t.id ? "default" : "pointer" }}
                  >
                    {cancellingId === t.id ? "Cancelling…" : "Cancel"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
