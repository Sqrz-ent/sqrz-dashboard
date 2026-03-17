export default function Crew() {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "36px 24px" }}>
      <h1 style={{ color: "#ffffff", fontSize: 24, fontWeight: 700, marginBottom: 10 }}>
        Crew
      </h1>
      <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 15, marginBottom: 32 }}>
        Manage your team and collaborators.
      </p>

      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid rgba(245,166,35,0.18)",
          borderRadius: 16,
          padding: "48px 32px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 16 }}>👥</div>
        <h2 style={{ color: "#ffffff", fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
          Coming Soon
        </h2>
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, maxWidth: 320, margin: "0 auto" }}>
          Search, invite, and manage the people you work with on every gig.
        </p>
      </div>
    </div>
  );
}
