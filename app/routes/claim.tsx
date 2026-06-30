import { useState } from "react";
import { useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/claim";
import { supabase } from "~/lib/supabase.client";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const slug = url.searchParams.get("slug") ?? "";
  return Response.json({ token, slug });
}

const FONT = "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

export default function ClaimPage() {
  const { token, slug } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    setLoading(true);

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        data: { claim_token: token, slug },
      },
    });

    setLoading(false);
    if (otpError) {
      setError("Something went wrong. Please try again.");
    } else {
      setEmail(email.trim().toLowerCase());
      setCode("");
      setSent(true);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || verifying) return;

    setError(null);
    setVerifying(true);

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });

    if (verifyError) {
      setError("Invalid or expired code");
      setVerifying(false);
      return;
    }

    navigate(
      `/claim/confirm?claim_token=${encodeURIComponent(token)}&slug=${encodeURIComponent(slug)}`,
      { replace: true }
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#111111",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT,
        padding: "20px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "#1a1a1a",
          border: "1px solid rgba(245,166,35,0.2)",
          borderRadius: 20,
          padding: "40px 32px",
          textAlign: "center",
        }}
      >
        {/* Logo */}
        <div style={{ marginBottom: 28 }}>
          <span style={{ fontSize: 22, fontWeight: 800, color: "#fff", letterSpacing: "0.2em" }}>
            [<span style={{ color: ACCENT }}> SQRZ </span>]
          </span>
        </div>

        {sent ? (
          <>
            <div style={{ fontSize: 40, marginBottom: 16 }}>📬</div>
            <h2 style={{ fontSize: 22, fontWeight: 800, color: "#fff", margin: "0 0 10px" }}>
              Enter your code
            </h2>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", margin: "0 0 24px", lineHeight: 1.6 }}>
              We sent a 6-digit code to <strong style={{ color: "rgba(255,255,255,0.8)" }}>{email}</strong>.
            </p>
            <form onSubmit={verifyCode}>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  background: "#111",
                  border: "1px solid rgba(245,166,35,0.3)",
                  borderRadius: 12,
                  fontSize: 20,
                  letterSpacing: "0.12em",
                  textAlign: "center",
                  color: "#fff",
                  outline: "none",
                  marginBottom: 14,
                  boxSizing: "border-box",
                  fontFamily: FONT,
                }}
              />

              {error && (
                <p style={{ fontSize: 13, color: "#ef4444", marginBottom: 12 }}>{error}</p>
              )}

              <button
                type="submit"
                disabled={verifying || code.length !== 6}
                style={{
                  width: "100%",
                  padding: "14px",
                  background: ACCENT,
                  color: "#111",
                  border: "none",
                  borderRadius: 12,
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: verifying || code.length !== 6 ? "not-allowed" : "pointer",
                  opacity: verifying || code.length !== 6 ? 0.7 : 1,
                  fontFamily: FONT,
                }}
              >
                {verifying ? "Verifying…" : "Claim profile"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#fff", margin: "0 0 8px", lineHeight: 1.2 }}>
              Claim your SQRZ profile
            </h1>
            {slug && (
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", margin: "0 0 24px" }}>
                {slug}.sqrz.com
              </p>
            )}
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.55)", margin: "0 0 28px", lineHeight: 1.6 }}>
              Enter your email to receive a 6-digit code and take full control of your profile.
            </p>

            <form onSubmit={handleSubmit}>
              <input
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  background: "#111",
                  border: "1px solid rgba(245,166,35,0.3)",
                  borderRadius: 12,
                  fontSize: 16,
                  color: "#fff",
                  outline: "none",
                  marginBottom: 14,
                  boxSizing: "border-box",
                  fontFamily: FONT,
                }}
              />

              {error && (
                <p style={{ fontSize: 13, color: "#ef4444", marginBottom: 12 }}>{error}</p>
              )}

              <button
                type="submit"
                disabled={loading || !email.trim()}
                style={{
                  width: "100%",
                  padding: "14px",
                  background: ACCENT,
                  color: "#111",
                  border: "none",
                  borderRadius: 12,
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: loading || !email.trim() ? "not-allowed" : "pointer",
                  opacity: loading || !email.trim() ? 0.7 : 1,
                  fontFamily: FONT,
                }}
              >
                {loading ? "Sending…" : "Send code"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
