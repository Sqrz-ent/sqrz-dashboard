// "Get the App" teaser for the Grow page's GET THE APP tab — a simple, enticing
// pitch for the iOS-only features, not an exhaustive feature dump.

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// KNOWN FOLLOW-UP: this is the TestFlight invite link, not permanent — swap
// to the App Store listing URL once SQRZ ships out of TestFlight.
const TESTFLIGHT_URL = "https://testflight.apple.com/join/qSyFdnSd";

const FEATURES = [
  { icon: "💬", label: "Live Chat" },
  { icon: "🔔", label: "Push Notifications" },
  { icon: "✨", label: "Daily Campaign Digest" },
  { icon: "🤖", label: "Campaign Advisor AI" },
  { icon: "🖼️", label: "Creative Asset Upload" },
];

export default function GetTheAppSection() {
  return (
    <div style={{ textAlign: "center", padding: "40px 20px 20px", fontFamily: FONT_BODY }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>📱</div>

      <h2
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 30,
          fontWeight: 800,
          color: "var(--text)",
          textTransform: "uppercase",
          letterSpacing: "0.02em",
          lineHeight: 1.15,
          margin: "0 0 12px",
        }}
      >
        The full Grow experience
        <br />
        is on iPhone
      </h2>

      <p
        style={{
          fontSize: 14,
          color: "var(--text-muted)",
          maxWidth: 420,
          margin: "0 auto 32px",
          lineHeight: 1.6,
        }}
      >
        Real-time updates and AI-powered insights, built for creators on the go.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 340, margin: "0 auto 32px" }}>
        {FEATURES.map((f) => (
          <div
            key={f.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "12px 16px",
              textAlign: "left",
            }}
          >
            <span style={{ fontSize: 18, flexShrink: 0 }}>{f.icon}</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{f.label}</span>
          </div>
        ))}
      </div>

      <a
        href={TESTFLIGHT_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "14px 28px",
          background: ACCENT,
          color: "#111",
          borderRadius: 12,
          fontSize: 15,
          fontWeight: 700,
          textDecoration: "none",
          fontFamily: FONT_BODY,
        }}
      >
        Get on TestFlight →
      </a>
    </div>
  );
}
