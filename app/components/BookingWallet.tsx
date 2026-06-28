import { useFetcher } from "react-router";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WalletData = {
  id: string;
  booking_id: string;
  owner_profile_id: string;
  total_budget: number | null;
  secured_amount: number | null;
  currency: string | null;
  sqrz_fee_pct: number;
  tax_pct: number | null;
  tax_amount: number | null;
  tax_label: string | null;
  client_paid: boolean;
  payout_status: string | null;
  delivery_confirmed_at: string | null;
  notes: string | null;
};

interface Props {
  wallet: WalletData;
  bookingStatus: string;
  requiresPayment?: boolean | null;
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function BookingWallet({ wallet, requiresPayment }: Props) {
  const paidFetcher = useFetcher<{ ok?: boolean }>();

  const taxPctVal = wallet.tax_pct ?? 0;
  const taxLabel  = wallet.tax_label ?? "Tax";
  // net = member's rate (before tax). No SQRZ fee.
  const memberRate      = wallet.secured_amount ?? 0;
  const taxAmt          = wallet.tax_amount ?? (taxPctVal > 0 ? Math.round(memberRate * taxPctVal / 100 * 100) / 100 : 0);
  const bookerPays      = wallet.total_budget ?? Math.round((memberRate + taxAmt) * 100) / 100;
  const hasTax          = taxPctVal > 0 || taxAmt > 0;
  const youReceiveGross = Math.round((memberRate + taxAmt) * 100) / 100;
  const yourNetIncome   = memberRate;

  const s = sym(wallet.currency);
  const isPaid = wallet.client_paid || (paidFetcher.state === "idle" && paidFetcher.data?.ok === true);
  const isManagedPayment = requiresPayment === true;

  function markAsPaid() {
    const fd = new FormData();
    fd.append("intent", "wallet_mark_paid");
    paidFetcher.submit(fd, { method: "post" });
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
          <p style={{ ...lbl, margin: "0 0 6px" }}>Total Rate (net)</p>
          <p style={{ color: "var(--text)", fontSize: 22, fontWeight: 800, margin: 0, fontFamily: FONT_DISPLAY }}>
            {s}{fmt(memberRate)}
          </p>
        </div>
        <div style={{
          flex: 1,
          background: "var(--bg)",
          border: "1px solid rgba(245,166,35,0.3)",
          borderRadius: 10,
          padding: "14px 16px",
        }}>
          <p style={{ ...lbl, margin: "0 0 6px" }}>Booker Paid</p>
          <p style={{ color: ACCENT, fontSize: 22, fontWeight: 800, margin: 0, fontFamily: FONT_DISPLAY }}>
            {s}{fmt(bookerPays)}
          </p>
        </div>
      </div>

      {/* ─── Fee breakdown card ─────────────────────────────────────────── */}
      <div style={card}>
        {/* Net rate row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
          <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: 0 }}>Total rate (net)</p>
          <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 700, margin: 0 }}>{s}{fmt(memberRate)}</p>
        </div>

        {/* Tax row — only when tax is set */}
        {hasTax && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
              {taxLabel}{taxPctVal > 0 ? ` (${taxPctVal}%)` : ""}
            </p>
            <p style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 600, margin: 0 }}>
              +{s}{fmt(taxAmt)}
            </p>
          </div>
        )}

        {/* Booker paid total */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0 2px" }}>
          <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 700, margin: 0 }}>Booker paid</p>
          <p style={{ color: "var(--text)", fontSize: 14, fontWeight: 800, margin: 0 }}>{s}{fmt(bookerPays)}</p>
        </div>

        {/* You receive breakdown */}
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 6, display: "flex", flexDirection: "column", gap: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: hasTax ? "1px solid var(--border)" : "none" }}>
            <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: 0 }}>You receive gross</p>
            <p style={{ color: ACCENT, fontSize: 13, fontWeight: 700, margin: 0 }}>{s}{fmt(youReceiveGross)}</p>
          </div>
          {hasTax && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <p style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", margin: 0 }}>
                  of which {taxLabel.toLowerCase()}{taxPctVal > 0 ? ` (${taxPctVal}%)` : ""} — remit to authority
                </p>
                <p style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", margin: 0 }}>−{s}{fmt(taxAmt)}</p>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0" }}>
                <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: 0 }}>Your net income</p>
                <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 700, margin: 0 }}>{s}{fmt(yourNetIncome)}</p>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0", lineHeight: 1.55 }}>
                Tax collected must be remitted to your local tax authority. You are responsible for invoicing and local tax compliance. SQRZ does not collect or remit taxes on your behalf.
              </p>
            </>
          )}
        </div>
      </div>

      {/* ─── Payment status ─────────────────────────────────────────────── */}
      <div style={card}>
        <p style={{ ...lbl, margin: "0 0 16px" }}>Payment Status</p>

        {/* Client payment row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: "0 0 5px" }}>
              {isManagedPayment ? "Client payment" : "Client payment (manual)"}
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
              {paidFetcher.state !== "idle"
                ? "Saving…"
                : isManagedPayment
                  ? "Mark as paid ✓"
                  : "Confirm payment received ✓"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
