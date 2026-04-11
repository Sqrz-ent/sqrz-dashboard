import { useState } from "react";
import { redirect, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/login";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { supabase } from "~/lib/supabase.client";

// ─── Styles ───────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
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
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "14px",
  background: "#F5A623",
  color: "#111111",
  border: "none",
  borderRadius: 12,
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
  marginBottom: 0,
};

// ─── Loader — redirect to dashboard if already logged in ──────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase: supabaseServer, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabaseServer.auth.getUser();

  if (user) return redirect("/", { headers });

  const url = new URL(request.url);
  const error = url.searchParams.get("error") ?? null;

  return Response.json({ error }, { headers });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Login() {
  const { error: urlError } = useLoaderData<typeof loader>();

  const [email, setEmail]             = useState("");
  const [password, setPassword]       = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState("");
  const [magicSent, setMagicSent]     = useState(false);

  function toggleMode() {
    setShowPassword((v) => !v);
    setError("");
  }

  async function sendMagicLink() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) { setError("Enter a valid email address"); return; }
    setLoading(true);
    setError("");
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { emailRedirectTo: "https://dashboard.sqrz.com/auth/callback" },
      });
      if (err) throw err;
      setMagicSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function loginWithPassword() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) { setError("Enter a valid email address"); return; }
    if (!password)               { setError("Enter your password"); return; }
    setLoading(true);
    setError("");
    try {
      const { error: err } = await supabase.auth.signInWithPassword({ email: trimmed, password });
      if (err) throw err;
      window.location.href = "/";
    } catch {
      setError("Invalid email or password");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit() {
    if (showPassword) loginWithPassword();
    else sendMagicLink();
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

        {/* Auth issue warning banner */}
        <div style={{
          background: "#FEF3C7",
          border: "1px solid #F5A623",
          borderRadius: 10,
          padding: "12px 16px",
          marginBottom: 24,
          fontSize: 13,
          color: "#92400E",
          lineHeight: 1.5,
        }}>
          🚧 We're currently experiencing issues with magic link sign-in. Our team is working on a fix. If you have trouble signing in, reach out to Will directly on Instagram{" "}
          <a href="https://instagram.com/willvilla" target="_blank" rel="noopener noreferrer" style={{ color: "#92400E", fontWeight: 700 }}>@willvilla</a>{" "}
          or via{" "}
          <a href="https://linkedin.com/in/soywillvilla" target="_blank" rel="noopener noreferrer" style={{ color: "#92400E", fontWeight: 700 }}>LinkedIn</a>.
          {" "}Sorry for the inconvenience!
        </div>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <span style={{ color: "#ffffff", fontSize: 20, fontWeight: 800, letterSpacing: "0.25em" }}>
            [<span style={{ color: "#F5A623" }}> SQRZ </span>]
          </span>
        </div>

        <h1
          style={{
            color: "#ffffff",
            fontSize: 24,
            fontWeight: 700,
            marginBottom: 32,
            textAlign: "center",
          }}
        >
          Log in to your account
        </h1>

        {urlError && (
          <p
            style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 10,
              color: "#ef4444",
              fontSize: 13,
              padding: "10px 14px",
              marginBottom: 24,
              textAlign: "center",
            }}
          >
            {urlError}
          </p>
        )}

        {/* ── Main card ──────────────────────────────────────────────────────── */}
        <div
          style={{
            background: "#1a1a1a",
            border: "1px solid rgba(245,166,35,0.2)",
            borderRadius: 16,
            padding: "24px",
            marginBottom: 24,
          }}
        >
          {magicSent ? (
            /* ── Magic link sent confirmation ──────────────────────────── */
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>✉️</div>
              <p style={{ color: "#ffffff", fontWeight: 600, marginBottom: 4, fontSize: 15 }}>
                Check your inbox
              </p>
              <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, marginBottom: 16 }}>
                We sent a magic link to{" "}
                <span style={{ color: "#F5A623" }}>{email.trim().toLowerCase()}</span>
              </p>
              <button
                onClick={() => { setMagicSent(false); setEmail(""); }}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(255,255,255,0.35)",
                  fontSize: 13,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                Use a different email
              </button>
            </div>
          ) : (
            <>
              {/* ── Email field ─────────────────────────────────────────── */}
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                placeholder="you@example.com"
                style={inputStyle}
                autoComplete="email"
                autoFocus
              />

              {/* ── Password field — slides in when showPassword ─────────── */}
              <div
                style={{
                  maxHeight: showPassword ? 120 : 0,
                  overflow: "hidden",
                  opacity: showPassword ? 1 : 0,
                  transition: "max-height 0.25s ease, opacity 0.2s ease",
                }}
              >
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && loginWithPassword()}
                  placeholder="Password"
                  style={inputStyle}
                  autoComplete="current-password"
                  tabIndex={showPassword ? 0 : -1}
                />
                <div style={{ textAlign: "right", marginTop: -6, marginBottom: 12 }}>
                  <Link
                    to="/reset-password"
                    style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}
                  >
                    Forgot password?
                  </Link>
                </div>
              </div>

              {/* ── Error ───────────────────────────────────────────────── */}
              {error && (
                <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 10, marginTop: -4 }}>
                  {error}
                </p>
              )}

              {/* ── Primary CTA ─────────────────────────────────────────── */}
              <button
                onClick={handleSubmit}
                disabled={loading}
                style={{ ...primaryButtonStyle, marginBottom: 16, opacity: loading ? 0.6 : 1 }}
              >
                {loading
                  ? showPassword ? "Logging in…" : "Sending…"
                  : showPassword ? "Login" : "Send Magic Link"}
              </button>

              {/* ── Toggle link ─────────────────────────────────────────── */}
              <div style={{ textAlign: "center" }}>
                <button
                  onClick={toggleMode}
                  style={{
                    background: "none",
                    border: "none",
                    color: "rgba(255,255,255,0.35)",
                    fontSize: 13,
                    cursor: "pointer",
                    padding: 0,
                    fontFamily: "inherit",
                  }}
                >
                  {showPassword ? "Use magic link instead" : "Login with password"}
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <p style={{ textAlign: "center", color: "rgba(255,255,255,0.4)", fontSize: 14, margin: 0 }}>
          Don't have an account?{" "}
          <Link to="/join" style={{ color: "#F5A623", textDecoration: "none", fontWeight: 600 }}>
            Create one →
          </Link>
        </p>

      </div>
    </div>
  );
}
