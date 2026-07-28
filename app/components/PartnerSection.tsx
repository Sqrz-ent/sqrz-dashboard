import { useState } from "react";
import type { PartnerSectionData, ReferralStatus } from "~/lib/partner.server";

// Presentational Partner dashboard — earnings, referral link, and the referral /
// booking-commission table. Rendered by both `_app.partners` (standalone route)
// and `_app.analytics` (the Grow page's PARTNER section, is_partner only). All
// data arrives via props.

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";
const ACCENT_BG = "rgba(245,166,35,0.12)";
const AMBER = "#fbbf24";
const GREEN = "#4ade80";
const BLUE = "#185FA5";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 12,
};

const lbl: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 4px",
  display: "block",
};

type TabKey = "active" | "booked" | "expired" | "pending";

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-EU", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n);
}

function nextMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

export type PartnerSectionProps = PartnerSectionData & {
  // When true, renders content-only (no centered page wrapper) so it can sit as a
  // section inside the Grow page.
  embedded?: boolean;
};

export default function PartnerSection({
  refCode,
  referrals,
  stats,
  earnings,
  bookingTotal,
  bookingCount,
  bookingRows,
  embedded = false,
}: PartnerSectionProps) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<TabKey>("active");
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  function copyReferralLink(slug: string) {
    const url = `https://${slug}.sqrz.com?ref=${refCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug(null), 1500);
    });
  }

  const refUrl = refCode ? `https://sqrz.com?ref=${refCode}` : null;

  function copyLink() {
    if (!refUrl) return;
    navigator.clipboard.writeText(refUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const filteredReferrals = tab === "booked"
    ? []
    : referrals.filter((r) => r.status === (tab as ReferralStatus));

  const tableLabels: Record<TabKey, string> = {
    active: "Active referrals",
    booked: "Booking commissions",
    expired: "Expired",
    pending: "Pending",
  };

  const tabDefs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "active",  label: "Active",  count: stats.active  },
    { key: "booked",  label: "Booked",  count: bookingRows.length },
    { key: "expired", label: "Expired", count: stats.expired },
    { key: "pending", label: "Pending", count: stats.pending },
  ];

  const outerStyle: React.CSSProperties = embedded
    ? { fontFamily: FONT_BODY, color: "var(--text)" }
    : { maxWidth: 820, margin: "0 auto", padding: "28px 20px 100px", fontFamily: FONT_BODY, color: "var(--text)" };

  return (
    <div style={outerStyle}>

      {/* ── Section 1: Header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px", color: "var(--text)" }}>Partner Program</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 2px" }}>
            Earn 70% commission on every subscription you refer — for 18 months from their first payment.
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 2px" }}>
            Average earning: $90–$130 per referred user.
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            You can earn additional commissions if you recommend your referrals to job opportunities.
          </p>
        </div>
        <span style={{
          padding: "4px 12px",
          borderRadius: 20,
          background: ACCENT_BG,
          color: ACCENT,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.04em",
          whiteSpace: "nowrap",
        }}>
          Partner
        </span>
      </div>

      {/* ── Section 2: Referral link ───────────────────────────────────────── */}
      {refUrl && (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>🔗</span>
          <span style={{ flex: 1, color: ACCENT, fontSize: 13, fontFamily: "monospace", wordBreak: "break-all" }}>
            {refUrl}
          </span>
          <button
            onClick={copyLink}
            style={{
              flexShrink: 0,
              padding: "7px 16px",
              borderRadius: 20,
              border: "none",
              background: copied ? "rgba(74,222,128,0.15)" : "var(--surface-muted)",
              color: copied ? GREEN : "var(--text)",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
      )}

      {/* ── Section 3: Earnings cards ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4" style={{ gap: 12, marginBottom: 20 }}>
        <div style={card}>
          <span style={lbl}>Lifetime earned</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "var(--text)" }}>{fmtMoney(earnings.lifetime)}</p>
        </div>
        <div style={{ ...card, borderColor: earnings.pending > 0 ? "rgba(251,191,36,0.3)" : "var(--border)" }}>
          <span style={lbl}>Pending payout</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: "0 0 2px", color: earnings.pending > 0 ? AMBER : "var(--text)" }}>
            {fmtMoney(earnings.pending)}
          </p>
          <div style={{ marginTop: 6, marginBottom: 6, display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
              <span>Subscriptions</span>
              <span>{fmtMoney(earnings.pendingSubTotal)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
              <span>Bookings</span>
              <span>{fmtMoney(earnings.pendingBookingTotal)}</span>
            </div>
          </div>
          {earnings.pending >= 25 ? (
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>Next batch {nextMonth()}</p>
          ) : (
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>€25 minimum</p>
          )}
        </div>
        <div style={{ ...card, borderColor: earnings.paid > 0 ? "rgba(74,222,128,0.3)" : "var(--border)" }}>
          <span style={lbl}>Subscriptions paid</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: "0 0 2px", color: earnings.paid > 0 ? GREEN : "var(--text)" }}>{fmtMoney(earnings.paid)}</p>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>from subscription commissions</p>
        </div>
        <div style={{ ...card, borderColor: bookingTotal > 0 ? "rgba(24,95,165,0.3)" : "var(--border)" }}>
          <span style={lbl}>Lifetime bookings</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: "0 0 2px", color: bookingTotal > 0 ? BLUE : "var(--text)" }}>
            {fmtMoney(bookingTotal)}
          </p>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
            from {bookingCount} completed booking{bookingCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {/* ── Section 5: Tab cards ──────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
        {tabDefs.map(({ key, label, count }) => {
          const isSelected = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                background: "var(--surface)",
                border: isSelected ? `1.5px solid ${ACCENT}` : "1px solid var(--border)",
                borderRadius: 10,
                padding: "12px 14px",
                cursor: "pointer",
                textAlign: "left",
                color: "var(--text)",
                fontFamily: FONT_BODY,
              }}
            >
              <p style={{ fontSize: 18, fontWeight: 700, margin: "0 0 2px", color: isSelected ? ACCENT : "var(--text)" }}>{count}</p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</p>
            </button>
          );
        })}
      </div>

      {/* ── Section 6: Table ──────────────────────────────────────────────── */}
      <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {tableLabels[tab]}
      </p>
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
          <thead>
            <tr style={{ background: "var(--surface-muted)", borderBottom: "1px solid var(--border)" }}>
              {(
                [
                  { label: "Referral",      width: "26%" },
                  { label: "Promote",       width: "24%" },
                  { label: "Your earnings", width: "26%" },
                  { label: "Status",        width: "24%" },
                ] as const
              ).map(({ label, width }) => (
                <th key={label} style={{ ...lbl, display: "table-cell", padding: "10px 14px", textAlign: "left", margin: 0, width }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tab === "booked" ? (
              bookingRows.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: "28px 14px", color: "var(--text-muted)", textAlign: "center" }}>
                    No booking commissions yet.
                  </td>
                </tr>
              ) : (
                bookingRows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "11px 14px", fontFamily: "monospace", color: "var(--text)", fontWeight: 600, overflow: "hidden" }}>
                      <span className="truncate block">{r.referred_slug}</span>
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      <span style={{
                        padding: "2px 8px",
                        borderRadius: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        background: "rgba(24,95,165,0.12)",
                        color: BLUE,
                      }}>
                        {r.stripe_mode === "test" ? "Booking · Test" : "Booking"}
                      </span>
                    </td>
                    <td style={{ padding: "11px 14px", fontWeight: 700 }}>
                      {fmtMoney(r.commission_amount)}
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      <span style={{
                        padding: "2px 8px",
                        borderRadius: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        background: "rgba(24,95,165,0.12)",
                        color: BLUE,
                      }}>
                        Booked
                      </span>
                    </td>
                  </tr>
                ))
              )
            ) : (
              filteredReferrals.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: "28px 14px", color: "var(--text-muted)", textAlign: "center" }}>
                    No referrals yet. Share your link to get started.
                  </td>
                </tr>
              ) : (
                filteredReferrals.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "11px 14px", fontFamily: "monospace", color: "var(--text)", fontWeight: 600, overflow: "hidden" }}>
                      <span className="truncate block">{r.slug}</span>
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      {r.hasStripeConnect ? (
                        <button
                          onClick={() => copyReferralLink(r.slug)}
                          style={{
                            padding: "2px 8px",
                            borderRadius: 20,
                            fontSize: 11,
                            fontWeight: 700,
                            background: copiedSlug === r.slug ? "rgba(74,222,128,0.15)" : ACCENT_BG,
                            color: copiedSlug === r.slug ? GREEN : ACCENT,
                            border: "none",
                            cursor: "pointer",
                            fontFamily: FONT_BODY,
                            whiteSpace: "nowrap",
                            transition: "all 0.15s",
                          }}
                        >
                          {copiedSlug === r.slug ? "Copied!" : "Copy Link"}
                        </button>
                      ) : (
                        <span style={{
                          padding: "2px 8px",
                          borderRadius: 20,
                          fontSize: 11,
                          fontWeight: 700,
                          background: "var(--surface-muted)",
                          color: "var(--text-muted)",
                        }}>
                          Stripe Required
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      {r.status === "pending" ? (
                        <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>not subscribed</span>
                      ) : (
                        <span style={{ fontWeight: r.earned > 0 ? 700 : 400, color: r.earned > 0 ? "var(--text)" : "var(--text-muted)" }}>
                          {fmtMoney(r.earned)}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      <StatusPill status={r.status} />
                    </td>
                  </tr>
                ))
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ReferralStatus }) {
  const map: Record<ReferralStatus, { label: string; bg: string; color: string }> = {
    active:  { label: "Active",  bg: "#E1F5EE", color: "#0F6E56" },
    expired: { label: "Expired", bg: "var(--surface-muted)", color: "var(--text-muted)" },
    pending: { label: "Pending", bg: "#FAEEDA", color: "#854F0B" },
  };
  const s = map[status];
  return (
    <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}
