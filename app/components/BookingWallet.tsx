import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WalletAllocation = {
  id: string;
  label: string | null;
  role: string | null;
  allocation_type: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  stripe_payment_link_url: string | null;
  paid_at: string | null;
  boost_campaign_id: string | null;
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

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  income:  { bg: "rgba(245,166,35,0.12)",  text: "#F5A623" },
  crew:    { bg: "rgba(96,165,250,0.12)",  text: "#60a5fa" },
  promo:   { bg: "rgba(167,139,250,0.12)", text: "#a78bfa" },
  expense: { bg: "var(--surface-muted)",   text: "var(--text-muted)" },
};

const TYPE_LABELS: Record<string, string> = {
  income:  "Income",
  crew:    "Crew Payments",
  promo:   "Promo",
  expense: "Expenses",
};

const LABEL_SUGGESTIONS: Record<string, string[]> = {
  income:  ["Artist Fee", "Door Split", "Performance Bonus"],
  crew:    ["Vocalist", "Sound Tech", "VJ", "Musician"],
  promo:   ["Ad Budget"],
  expense: ["Transport", "Hotel", "Food"],
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const c = TYPE_COLORS[type] ?? TYPE_COLORS.expense;
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 7px",
      borderRadius: 20,
      fontSize: 10,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      background: c.bg,
      color: c.text,
    }}>
      {type}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BookingWallet({ wallet }: Props) {
  const [payoutToast, setPayoutToast] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newType,   setNewType]   = useState<string>("expense");
  const [newLabel,  setNewLabel]  = useState("Transport");
  const [newAmount, setNewAmount] = useState("");

  const paidFetcher   = useFetcher<{ ok?: boolean }>();
  const addFetcher    = useFetcher<{ ok?: boolean }>();
  const payReqFetcher = useFetcher<{ ok?: boolean; url?: string }>();

  useEffect(() => {
    if (addFetcher.state === "idle" && addFetcher.data?.ok) {
      setShowAddForm(false);
      setNewType("expense");
      setNewLabel("Transport");
      setNewAmount("");
    }
  }, [addFetcher.state, addFetcher.data]);

  // When type changes, reset label to first suggestion
  useEffect(() => {
    setNewLabel(LABEL_SUGGESTIONS[newType]?.[0] ?? "");
  }, [newType]);

  const allocations = wallet.allocations ?? [];

  // Group by allocation_type (fall back to "expense" for legacy rows without type)
  const byType = (type: string) =>
    allocations.filter((a) => (a.allocation_type ?? "expense") === type);
  const incomeAllocs  = byType("income");
  const crewAllocs    = byType("crew");
  const promoAllocs   = byType("promo");
  const expenseAllocs = byType("expense");

  const incomeSum  = incomeAllocs.reduce((s, a)  => s + (a.amount ?? 0), 0);
  const crewSum    = crewAllocs.reduce((s, a)    => s + (a.amount ?? 0), 0);
  const promoSum   = promoAllocs.reduce((s, a)   => s + (a.amount ?? 0), 0);
  const expenseSum = expenseAllocs.reduce((s, a) => s + (a.amount ?? 0), 0);

  const hasTypedAllocations = allocations.some((a) => !!a.allocation_type);
  const effectiveIncome = hasTypedAllocations ? incomeSum : (wallet.total_budget ?? 0);

  const feePct  = wallet.sqrz_fee_pct ?? 10;
  const sqrzFee = Math.round(effectiveIncome * (feePct / 100) * 100) / 100;
  const net     = Math.round((effectiveIncome - crewSum - promoSum - expenseSum - sqrzFee) * 100) / 100;

  const s = sym(wallet.currency);
  const isPaid = wallet.client_paid || (paidFetcher.state === "idle" && paidFetcher.data?.ok === true);

  function markAsPaid() {
    const fd = new FormData();
    fd.append("intent", "wallet_mark_paid");
    paidFetcher.submit(fd, { method: "post" });
  }

  function requestPayout() {
    setPayoutToast(true);
    setTimeout(() => setPayoutToast(false), 3000);
  }

  function requestPayment(allocationId: string, amount: number, currency: string) {
    const fd = new FormData();
    fd.append("intent", "wallet_request_payment");
    fd.append("allocation_id", allocationId);
    fd.append("wallet_id", wallet.id);
    fd.append("amount", String(amount));
    fd.append("currency", currency || wallet.currency || "EUR");
    payReqFetcher.submit(fd, { method: "post" });
  }

  const inputSt: React.CSSProperties = {
    padding: "9px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 13,
    outline: "none",
    fontFamily: FONT_BODY,
    boxSizing: "border-box" as const,
  };

  function AllocationRow({ a }: { a: WalletAllocation }) {
    const isPaidAlloc = a.status === "paid" || !!a.paid_at;
    const displayLabel = a.label ?? a.role ?? "Item";
    const aType = a.allocation_type ?? "expense";
    const isIncome = aType === "income";
    const isPromo  = aType === "promo";
    const isPending = a.status === "pending";
    const hasPayLink = !!a.stripe_payment_link_url;

    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "9px 0",
        borderBottom: "1px solid var(--border)",
        gap: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <TypeBadge type={aType} />
          <span style={{ color: "var(--text)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayLabel}
          </span>
          {isPaidAlloc && (
            <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 700, textTransform: "uppercase", flexShrink: 0 }}>
              Paid
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{
            color: isIncome ? "var(--text)" : "var(--text-muted)",
            fontSize: 13,
            fontWeight: 600,
          }}>
            {isIncome ? "" : "−"}{s}{fmt(a.amount ?? 0)}
          </span>
          {isIncome && isPending && !hasPayLink && (
            <button
              onClick={() => requestPayment(a.id, a.amount ?? 0, a.currency ?? wallet.currency ?? "EUR")}
              disabled={payReqFetcher.state !== "idle"}
              style={{
                padding: "4px 10px",
                background: "rgba(245,166,35,0.12)",
                border: "1px solid rgba(245,166,35,0.3)",
                borderRadius: 6,
                color: ACCENT,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT_BODY,
                whiteSpace: "nowrap",
              }}
            >
              {payReqFetcher.state !== "idle" ? "…" : "Request Payment"}
            </button>
          )}
          {isIncome && hasPayLink && !isPaidAlloc && (
            <a
              href={a.stripe_payment_link_url!}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: "4px 10px",
                background: "rgba(74,222,128,0.12)",
                border: "1px solid rgba(74,222,128,0.3)",
                borderRadius: 6,
                color: "#4ade80",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: FONT_BODY,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              Copy Link ↗
            </a>
          )}
          {isPromo && !a.boost_campaign_id && (
            <a
              href={`/boost?amount=${a.amount ?? 0}&allocation_id=${a.id}`}
              style={{
                padding: "4px 10px",
                background: "rgba(167,139,250,0.12)",
                border: "1px solid rgba(167,139,250,0.3)",
                borderRadius: 6,
                color: "#a78bfa",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: FONT_BODY,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              Activate Campaign →
            </a>
          )}
          {isPromo && !!a.boost_campaign_id && (
            <span style={{ fontSize: 10, color: "#a78bfa", fontWeight: 700, textTransform: "uppercase" }}>
              Campaign linked
            </span>
          )}
        </div>
      </div>
    );
  }

  function GroupSection({ type, items }: { type: string; items: WalletAllocation[] }) {
    if (items.length === 0) return null;
    const color = TYPE_COLORS[type]?.text ?? "var(--text-muted)";
    return (
      <div>
        <p style={{ ...lbl, color, margin: "14px 0 2px" }}>
          {TYPE_LABELS[type] ?? type}
        </p>
        {items.map((a) => <AllocationRow key={a.id} a={a} />)}
      </div>
    );
  }

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

      {/* ─── Summary boxes ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <div style={{
          flex: 1,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "14px 16px",
        }}>
          <p style={{ ...lbl, margin: "0 0 6px" }}>Total budget</p>
          <p style={{ color: "var(--text)", fontSize: 22, fontWeight: 800, margin: 0, fontFamily: FONT_DISPLAY }}>
            {s}{fmt(wallet.total_budget ?? 0)}
          </p>
        </div>
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

      {/* ─── Grouped breakdown ─────────────────────────────────────────── */}
      <div style={card}>
        {hasTypedAllocations ? (
          <>
            <GroupSection type="income"  items={incomeAllocs} />
            <GroupSection type="crew"    items={crewAllocs} />
            <GroupSection type="promo"   items={promoAllocs} />
            <GroupSection type="expense" items={expenseAllocs} />
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text)", fontSize: 13, margin: 0 }}>Booking rate</p>
            <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 700, margin: 0 }}>
              {s}{fmt(wallet.total_budget ?? 0)}
            </p>
          </div>
        )}

        {/* SQRZ fee */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 0",
          borderBottom: "1px solid var(--border)",
          marginTop: hasTypedAllocations ? 8 : 0,
        }}>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            SQRZ fee{" "}
            <span style={{ fontSize: 11, opacity: 0.65 }}>({feePct}% of income)</span>
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

      {/* ─── Add line item ─────────────────────────────────────────────── */}
      {!showAddForm ? (
        <button
          onClick={() => setShowAddForm(true)}
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
          + Add line item
        </button>
      ) : (
        <div style={{ ...card, border: "1px solid rgba(245,166,35,0.25)" }}>
          <p style={{ ...lbl, margin: "0 0 12px" }}>Add line item</p>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 100px", gap: 10, marginBottom: 12 }}>
            <div>
              <p style={{ ...lbl, marginBottom: 5 }}>Type</p>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                style={{ ...inputSt, width: "100%" }}
              >
                <option value="income">Income</option>
                <option value="crew">Crew</option>
                <option value="promo">Promo</option>
                <option value="expense">Expense</option>
              </select>
            </div>
            <div>
              <p style={{ ...lbl, marginBottom: 5 }}>Label</p>
              <input
                type="text"
                list={`label-suggestions-${newType}`}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label"
                style={{ ...inputSt, width: "100%" }}
              />
              <datalist id={`label-suggestions-${newType}`}>
                {(LABEL_SUGGESTIONS[newType] ?? []).map((s2) => (
                  <option key={s2} value={s2} />
                ))}
              </datalist>
            </div>
            <div>
              <p style={{ ...lbl, marginBottom: 5 }}>Amount</p>
              <input
                type="number"
                min={0}
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                placeholder="0"
                style={{ ...inputSt, width: "100%", textAlign: "right" as const }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                const fd = new FormData();
                fd.append("intent", "add_wallet_allocation");
                fd.append("wallet_id", wallet.id);
                fd.append("allocation_type", newType);
                fd.append("label", newLabel);
                fd.append("amount", newAmount);
                fd.append("currency", wallet.currency ?? "EUR");
                addFetcher.submit(fd, { method: "post" });
              }}
              disabled={addFetcher.state !== "idle" || !newAmount || !newLabel}
              style={{
                flex: 1,
                padding: "10px",
                background: ACCENT,
                color: "#111",
                border: "none",
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 700,
                cursor: (addFetcher.state !== "idle" || !newAmount || !newLabel) ? "default" : "pointer",
                opacity: (addFetcher.state !== "idle" || !newAmount || !newLabel) ? 0.6 : 1,
                fontFamily: FONT_BODY,
              }}
            >
              {addFetcher.state !== "idle" ? "Saving…" : "Add"}
            </button>
            <button
              onClick={() => {
                setShowAddForm(false);
                setNewType("expense");
                setNewLabel("Transport");
                setNewAmount("");
              }}
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

      {/* ─── Payment status ─────────────────────────────────────────────── */}
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
