import { useState } from "react";
import { useSearchParams } from "react-router";
import { supabase } from "~/lib/supabase.client";

export default function GuestLogin() {
  const [searchParams] = useSearchParams();
  const bookingId = searchParams.get("booking") ?? "";

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@")) {
      setError("Enter a valid email address");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const redirectTo = bookingId
        ? `https://dashboard.sqrz.com/booking/${bookingId}`
        : "https://dashboard.sqrz.com";

      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: normalized,
        options: { emailRedirectTo: redirectTo },
      });
      if (otpError) throw otpError;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

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
      <div style={{ width: "100%", maxWidth: 420 }}>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <span style={{ color: "#ffffff", fontSize: 20, fontWeight: 800, letterSpacing: "0.25em" }}>
            [<span style={{ color: "#F5A623" }}> SQRZ </span>]
          </span>
        </div>

        {sent ? (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 44, marginBottom: 16 }}>✉️</div>
            <h2 style={{ color: "#ffffff", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
              Check your inbox
            </h2>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, marginBottom: 24 }}>
              We sent an access link to{" "}
              <span style={{ color: "#F5A623" }}>{email.trim().toLowerCase()}</span>
            </p>
            <button
              onClick={() => { setSent(false); setEmail(""); }}
              style={{
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.35)",
                fontSize: 14,
                cursor: "pointer",
                padding: 0,
              }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <h1
              style={{
                color: "#ffffff",
                fontSize: 24,
                fontWeight: 700,
                marginBottom: 8,
                textAlign: "center",
              }}
            >
              Access your booking
            </h1>
            <p
              style={{
                color: "rgba(255,255,255,0.4)",
                fontSize: 14,
                textAlign: "center",
                marginBottom: 32,
              }}
            >
              Enter your email and we'll send you an access link.
            </p>

            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="you@example.com"
              autoFocus
              style={{
                width: "100%",
                padding: "14px 16px",
                background: "#1a1a1a",
                border: "1px solid rgba(245,166,35,0.3)",
                borderRadius: 12,
                fontSize: 16,
                color: "#ffffff",
                outline: "none",
                marginBottom: 12,
                boxSizing: "border-box",
              }}
              autoComplete="email"
            />

            {error && (
              <p style={{ color: "#ef4444", fontSize: 13, marginTop: 0, marginBottom: 10 }}>
                {error}
              </p>
            )}

            <button
              onClick={handleSubmit}
              disabled={loading}
              style={{
                width: "100%",
                padding: "14px",
                background: "#F5A623",
                color: "#111111",
                border: "none",
                borderRadius: 12,
                fontSize: 16,
                fontWeight: 700,
                cursor: loading ? "default" : "pointer",
                opacity: loading ? 0.6 : 1,
                marginBottom: 20,
              }}
            >
              {loading ? "Sending…" : "Send access link"}
            </button>
          </>
        )}

      </div>
    </div>
  );
}
