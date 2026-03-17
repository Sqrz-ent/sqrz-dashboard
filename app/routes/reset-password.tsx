import { useState } from "react";
import { redirect, Link } from "react-router";
import type { Route } from "./+types/reset-password";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { supabase } from "~/lib/supabase.client";

// ─── Loader — redirect to dashboard if already logged in ──────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabaseServer = createSupabaseServerClient(request, responseHeaders);
  const {
    data: { session },
  } = await supabaseServer.auth.getSession();

  if (session) return redirect("/", { headers: responseHeaders });

  return null;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ResetPassword() {
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
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalized, {
        redirectTo: "https://dashboard.sqrz.com/auth/callback",
      });
      if (resetError) throw resetError;
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
              We sent a password reset link to{" "}
              <span style={{ color: "#F5A623" }}>{email.trim().toLowerCase()}</span>
            </p>
            <Link
              to="/login"
              style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, textDecoration: "none" }}
            >
              ← Back to login
            </Link>
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
              Reset your password
            </h1>
            <p
              style={{
                color: "rgba(255,255,255,0.4)",
                fontSize: 14,
                textAlign: "center",
                marginBottom: 32,
              }}
            >
              Enter your email and we'll send you a reset link.
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
              {loading ? "Sending…" : "Send reset link"}
            </button>

            <p style={{ textAlign: "center", margin: 0 }}>
              <Link
                to="/login"
                style={{ color: "rgba(255,255,255,0.35)", fontSize: 14, textDecoration: "none" }}
              >
                ← Back to login
              </Link>
            </p>
          </>
        )}

      </div>
    </div>
  );
}
