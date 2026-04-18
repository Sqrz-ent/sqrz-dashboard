import { useState } from "react";
import { useLoaderData } from "react-router";
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

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    setLoading(true);

    // Encode claim_token and slug into the post-auth redirect path
    const next = encodeURIComponent(
      `/claim/confirm?claim_token=${encodeURIComponent(token)}&slug=${encodeURIComponent(slug)}`
    );
    const emailRedirectTo = `https://dashboard.sqrz.com/auth/callback?next=${next}`;

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo,
        data: { claim_token: token },
      },
    });

    setLoading(false);
    if (otpError) {
      setError("Something went wrong. Please try again.");
    } else {
      setSent(true);
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
              Check your email
            </h2>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", margin: 0, lineHeight: 1.6 }}>
              We sent a magic link to <strong style={{ color: "rgba(255,255,255,0.8)" }}>{email}</strong>.
              Click it to claim your profile.
            </p>
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
              Enter your email to receive a magic link and take full control of your profile.
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
                {loading ? "Sending…" : "Send me a magic link"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
