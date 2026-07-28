export default function PartnerInviteBanner({ invitedAt }: { invitedAt: string | null }) {
  return (
    <div
      style={{
        margin: "16px 24px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: "20px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <span style={{ fontSize: 20, marginTop: 1, color: "#F5A623" }}>✦</span>
        <div>
          <p style={{ fontSize: 14, fontWeight: 500, color: "var(--text)", margin: "0 0 4px" }}>
            You&apos;re invited to share SQRZ beta access
          </p>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            Get an invite link for trusted people who should test the iOS app.
          </p>
        </div>
      </div>

      <a
        href="/invite-onboarding"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "#F5A623",
          color: "#111",
          fontWeight: 600,
          fontSize: 13,
          padding: "10px 18px",
          borderRadius: 10,
          textDecoration: "none",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        View invite →
      </a>
    </div>
  );
}
