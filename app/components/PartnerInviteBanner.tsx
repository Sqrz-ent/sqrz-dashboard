import { Link } from "react-router";

const ACCENT = "#F5A623";

export default function PartnerInviteBanner({ invitedAt }: { invitedAt: string | null }) {
  return (
    <div
      style={{
        width: "100%",
        background: "#FEF3E2",
        borderLeft: `3px solid ${ACCENT}`,
        borderBottom: "1px solid rgba(245,166,35,0.25)",
        padding: "12px 20px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        boxSizing: "border-box",
      }}
    >
      <span style={{ fontSize: 16, flexShrink: 0 }}>✦</span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#1a1a1a", lineHeight: 1.4 }}>
          Will Villa has invited you to join the SQRZ Partner Program
        </p>
        <p style={{ margin: "2px 0 0", fontSize: 13, color: "#555", lineHeight: 1.4 }}>
          Earn commissions by referring creatives to SQRZ.
        </p>
      </div>
      <Link
        to="/office/partner-onboarding"
        style={{
          display: "inline-block",
          padding: "8px 18px",
          background: ACCENT,
          color: "#111",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 700,
          textDecoration: "none",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        Learn more &amp; accept →
      </Link>
    </div>
  );
}
