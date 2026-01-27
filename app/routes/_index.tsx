export default function DashboardHome() {
  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "48px 24px",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
        background: "#0b0f17",
        color: "#e5e7eb",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <h1 style={{ fontSize: 36, marginBottom: 8 }}>SQRZ Dashboard</h1>
        <p style={{ opacity: 0.75, marginBottom: 32 }}>
          Manage your profile, bookings, and payouts.
        </p>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 16,
          }}
        >
          <Card
            title="👤 Profile"
            description="Edit your public profile, bio, media, and skills."
          />
          <Card
            title="📅 Bookings"
            description="View upcoming and past bookings."
          />
          <Card
            title="💳 Payments"
            description="Manage payouts and Stripe connection."
          />
        </section>

        {/* 👇 PUT THE LINK HERE */}
        <a
          href="/profile"
          style={{
            marginTop: 24,
            display: "inline-block",
            color: "#f3b130",
            fontWeight: 700,
          }}
        >
          Go to profile →
        </a>
      </div>
    </main>
  );
}




function Card({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        background: "#101827",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 16,
        padding: 20,
      }}
    >
      <h2 style={{ margin: 0, marginBottom: 8 }}>{title}</h2>
      <p style={{ margin: 0, opacity: 0.7 }}>{description}</p>
    </div>
  );
}

