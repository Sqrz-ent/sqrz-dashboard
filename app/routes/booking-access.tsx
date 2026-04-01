export default function BookingAccess() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#111111",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
        <div style={{ marginBottom: 32 }}>
          <span style={{ color: "#ffffff", fontSize: 20, fontWeight: 800, letterSpacing: "0.25em" }}>
            [<span style={{ color: "#F5A623" }}> SQRZ </span>]
          </span>
        </div>
        <h1 style={{ color: "#ffffff", fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
          No booking found
        </h1>
        <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 14, lineHeight: 1.6, marginBottom: 28 }}>
          You don't have any active bookings. If you received a booking link, please use that link to access your booking.
        </p>
        <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 13 }}>
          Are you a creator?{" "}
          <a href="/login" style={{ color: "#F5A623", textDecoration: "none" }}>
            Log in here →
          </a>
        </p>
      </div>
    </div>
  );
}
