import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WalletAllocation = {
  id: string;
  role: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
};

export type WalletData = {
  id: string;
  booking_id: string;
  owner_profile_id: string;
  total_budget: number | null;
  currency: string | null;
  sqrz_fee_pct: number;
  client_paid: boolean;
  payout_status: string | null;
  notes: string | null;
  allocations?: WalletAllocation[];
};

interface Props {
  wallet: WalletData;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCENT = "#F5A623";
const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 14,
};

const lbl: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 4px",
};

function sym(currency: string | null) {
  const c = currency?.toUpperCase();
  return c === "EUR" ? "€" : c === "GBP" ? "£" : "$";
}

function fmt(n: number) {
  return Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BookingWallet({ wallet }: Props) {
  // Parse costs from notes JSON
  let savedNotes: { transport?: number; hotel?: number; food?: number } = {};
  try {
    if (wallet.notes) savedNotes = JSON.parse(wallet.notes);
  } catch { /* ignore */ }

  const [transport, setTransport] = useState<number>(savedNotes.transport ?? 0);
  const [hotel,     setHotel]     = useState<number>(savedNotes.hotel ?? 0);
  const [food,      setFood]      = useState<number>(savedNotes.food ?? 0);
  const [payoutToast, setPayoutToast] = useState(false);

  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expLabel,  setExpLabel]  = useState("Transport");
  const [expAmount, setExpAmount] = useState("");

  const saveFetcher    = useFetcher<{ ok?: boolean }>();
  const paidFetcher    = useFetcher<{ ok?: boolean }>();
  const expenseFetcher = useFetcher<{ ok?: boolean }>();

  // Close the form and reset on successful submission
  useEffect(() => {
    if (expenseFetcher.state === "idle" && expenseFetcher.data?.ok) {
      setShowExpenseForm(false);
      setExpLabel("Transport");
      setExpAmount("");
    }
  }, [expenseFetcher.state, expenseFetcher.data]);

  const allocations   = wallet.allocations ?? [];
  const allocationSum = allocations.reduce((sum, a) => sum + (a.amount ?? 0), 0);

  const s        = sym(wallet.currency);
  const rate     = wallet.total_budget ?? 0;
  const costs    = transport + hotel + food + allocationSum;
  const netRaw   = rate - costs;
  const feePct   = wallet.sqrz_fee_pct ?? 10;
  const sqrzFee  = Math.round(netRaw * (feePct / 100) * 100) / 100;
  const net      = Math.round((netRaw - sqrzFee) * 100) / 100;

  const isPaid = wallet.client_paid || (paidFetcher.state === "idle" && paidFetcher.data?.ok === true);

  function saveCosts() {
    const fd = new FormData();
    fd.append("intent", "wallet_save_costs");
    fd.append("transport", String(transport));
    fd.append("hotel", String(hotel));
    fd.append("food", String(food));
    saveFetcher.submit(fd, { method: "post" });
  }

  function markAsPaid() {
    const fd = new FormData();
    fd.append("intent", "wallet_mark_paid");
    paidFetcher.submit(fd, { method: "post" });
  }

  function requestPayout() {
    setPayoutToast(true);
    setTimeout(() => setPayoutToast(false), 3000);
  }

  const costInput: React.CSSProperties = {
    padding: "7px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 14,
    fontWeight: 600,
    outline: "none",
    width: 90,
    boxSizing: "border-box",
    fontFamily: FONT_BODY,
    textAlign: "right",
  };

  return (
    <section id="payments" style={{ paddingBottom: 40, fontFamily: FONT_BODY }}>
      <h2 style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 26,
        fontWeight: 800,
        color: ACCENT,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "0 0 16px",
        lineHeight: 1.1,
      }}>
        Payments
      </h2>

      {/* ─── Card 1: Breakdown ──────────────────────────────────────── */}
      <div style={card}>
        {/* Metric boxes */}
        <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
          {/* Total budget */}
          <div style={{
            flex: 1,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "14px 16px",
          }}>
            <p style={{ ...lbl, margin: "0 0 6px" }}>Total budget</p>
            <p style={{ color: "var(--text)", fontSize: 22, fontWeight: 800, margin: 0, fontFamily: FONT_DISPLAY }}>
              {s}{fmt(rate)}
            </p>
          </div>
          {/* Your net */}
          <div style={{
            flex: 1,
            background: "var(--bg)",
            border: `1px solid ${net >= 0 ? "rgba(245,166,35,0.3)" : "rgba(239,68,68,0.3)"}`,
            borderRadius: 10,
            padding: "14px 16px",
          }}>
            <p style={{ ...lbl, margin: "0 0 6px" }}>Your net</p>
            <p style={{ color: net >= 0 ? ACCENT : "#ef4444", fontSize: 22, fontWeight: 800, margin: 0, fontFamily: FONT_DISPLAY }}>
              {net < 0 ? "−" : ""}{s}{fmt(net)}
            </p>
          </div>
        </div>

        {/* Line items */}
        <div>
          {/* Booking rate */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text)", fontSize: 13, margin: 0 }}>Booking rate</p>
            <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 700, margin: 0 }}>{s}{fmt(rate)}</p>
          </div>

          {/* Transport */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>Transport</p>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{s}</span>
              <input
                type="number"
                min={0}
                value={transport}
                onChange={(e) => setTransport(parseFloat(e.target.value) || 0)}
                onBlur={saveCosts}
                style={costInput}
              />
            </div>
          </div>

          {/* Hotel */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>Hotel</p>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{s}</span>
              <input
                type="number"
                min={0}
                value={hotel}
                onChange={(e) => setHotel(parseFloat(e.target.value) || 0)}
                onBlur={saveCosts}
                style={costInput}
              />
            </div>
          </div>

          {/* Food & other */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>Food & other</p>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{s}</span>
              <input
                type="number"
                min={0}
                value={food}
                onChange={(e) => setFood(parseFloat(e.target.value) || 0)}
                onBlur={saveCosts}
                style={costInput}
              />
            </div>
          </div>

          {/* DB expense allocations */}
          {allocations.map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>{a.role ?? "Expense"}</p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 600, margin: 0 }}>
                −{s}{fmt(a.amount ?? 0)}
              </p>
            </div>
          ))}

          {/* SQRZ fee */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
              SQRZ fee{" "}
              <span style={{ fontSize: 11, opacity: 0.65 }}>({feePct}% of net before fee)</span>
            </p>
            <p style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 600, margin: 0 }}>
              −{s}{fmt(sqrzFee)}
            </p>
          </div>

          {/* Your net total */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0 2px" }}>
            <p style={{ color: "var(--text)", fontSize: 14, fontWeight: 700, margin: 0 }}>Your net</p>
            <p style={{ color: net >= 0 ? ACCENT : "#ef4444", fontSize: 16, fontWeight: 800, margin: 0 }}>
              {net < 0 ? "−" : ""}{s}{fmt(net)}
            </p>
          </div>
        </div>

        {saveFetcher.state !== "idle" && (
          <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "10px 0 0", textAlign: "right" }}>
            Saving…
          </p>
        )}
      </div>

      {/* ─── Add expense ─────────────────────────────────────────────── */}
      {!showExpenseForm ? (
        <button
          onClick={() => setShowExpenseForm(true)}
          style={{
            display: "block",
            width: "100%",
            padding: "11px",
            background: "transparent",
            border: "1px dashed var(--border)",
            borderRadius: 10,
            color: "var(--text-muted)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: FONT_BODY,
            marginBottom: 14,
          }}
        >
          + Add expense
        </button>
      ) : (
        <div style={{ ...card, border: "1px solid rgba(245,166,35,0.25)" }}>
          <p style={{ ...lbl, margin: "0 0 12px" }}>Add expense</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10, marginBottom: 12 }}>
            <div>
              <p style={{ ...lbl, marginBottom: 5 }}>Label</p>
              <select
                value={expLabel}
                onChange={(e) => setExpLabel(e.target.value)}
                style={{
                  width: "100%",
                  padding: "9px 10px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: 13,
                  outline: "none",
                  fontFamily: FONT_BODY,
                }}
              >
                <option>Transport</option>
                <option>Hotel</option>
                <option>Food</option>
                <option>Other</option>
              </select>
            </div>
            <div>
              <p style={{ ...lbl, marginBottom: 5 }}>Amount</p>
              <input
                type="number"
                min={0}
                value={expAmount}
                onChange={(e) => setExpAmount(e.target.value)}
                placeholder="0"
                style={{
                  width: "100%",
                  padding: "9px 10px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: 13,
                  outline: "none",
                  boxSizing: "border-box" as const,
                  fontFamily: FONT_BODY,
                }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                const fd = new FormData();
                fd.append("intent", "add_expense");
                fd.append("wallet_id", wallet.id);
                fd.append("expense_label", expLabel);
                fd.append("expense_amount", expAmount);
                fd.append("currency", wallet.currency ?? "EUR");
                expenseFetcher.submit(fd, { method: "post" });
              }}
              disabled={expenseFetcher.state !== "idle" || !expAmount}
              style={{
                flex: 1,
                padding: "10px",
                background: ACCENT,
                color: "#111",
                border: "none",
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 700,
                cursor: expenseFetcher.state !== "idle" || !expAmount ? "default" : "pointer",
                opacity: expenseFetcher.state !== "idle" || !expAmount ? 0.6 : 1,
                fontFamily: FONT_BODY,
              }}
            >
              {expenseFetcher.state !== "idle" ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => { setShowExpenseForm(false); setExpLabel("Transport"); setExpAmount(""); }}
              style={{
                padding: "10px 18px",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 9,
                fontSize: 13,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ─── Card 2: Payment status ──────────────────────────────────── */}
      <div style={card}>
        <p style={{ ...lbl, margin: "0 0 16px" }}>Payment Status</p>

        {/* Client payment row */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: 16,
          marginBottom: 16,
          borderBottom: "1px solid var(--border)",
        }}>
          <div>
            <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: "0 0 5px" }}>
              Client payment
            </p>
            <span style={{
              display: "inline-block",
              padding: "2px 10px",
              borderRadius: 20,
              fontSize: 11,
              fontWeight: 700,
              background: isPaid ? "rgba(74,222,128,0.12)" : "rgba(245,166,35,0.12)",
              color: isPaid ? "#4ade80" : ACCENT,
            }}>
              {isPaid ? "Paid" : "Unpaid"}
            </span>
          </div>
          {!isPaid && (
            <button
              onClick={markAsPaid}
              disabled={paidFetcher.state !== "idle"}
              style={{
                padding: "9px 18px",
                background: "#4ade80",
                color: "#111",
                border: "none",
                borderRadius: 9,
                fontSize: 12,
                fontWeight: 700,
                cursor: paidFetcher.state !== "idle" ? "default" : "pointer",
                opacity: paidFetcher.state !== "idle" ? 0.7 : 1,
                fontFamily: FONT_BODY,
                whiteSpace: "nowrap",
              }}
            >
              {paidFetcher.state !== "idle" ? "Saving…" : "Mark as paid ✓"}
            </button>
          )}
        </div>

        {/* Payout row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: "0 0 5px" }}>
              Payout
            </p>
            <span style={{
              display: "inline-block",
              padding: "2px 10px",
              borderRadius: 20,
              fontSize: 11,
              fontWeight: 700,
              background: "var(--surface-muted)",
              color: "var(--text-muted)",
              textTransform: "capitalize",
            }}>
              {wallet.payout_status ?? "Not initiated"}
            </span>
          </div>
          <div style={{ position: "relative" }}>
            <button
              onClick={requestPayout}
              style={{
                padding: "9px 18px",
                background: "var(--surface-muted)",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                borderRadius: 9,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FONT_BODY,
                whiteSpace: "nowrap",
              }}
            >
              Request payout
            </button>
            {payoutToast && (
              <div style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 8px)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 9,
                padding: "10px 16px",
                fontSize: 12,
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
                boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
                zIndex: 10,
              }}>
                Coming soon — contact us for manual payout
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
