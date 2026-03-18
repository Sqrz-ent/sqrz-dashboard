import { useState } from "react";
import { redirect, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/login";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { supabase } from "~/lib/supabase.client";

// ─── Shared styles (mirrors join.tsx design tokens) ───────────────────────────

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
  marginBottom: 8,
};

const secondaryButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "14px",
  background: "transparent",
  color: "#ffffff",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 12,
  fontSize: 16,
  fontWeight: 600,
  cursor: "pointer",
  marginBottom: 8,
};

// ─── Loader — redirect to dashboard if already logged in ──────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabaseServer = createSupabaseServerClient(request, responseHeaders);
  const {
    data: { user },
  } = await supabaseServer.auth.getUser();

  if (user) return redirect("/", { headers: responseHeaders });

  const url = new URL(request.url);
  const error = url.searchParams.get("error") ?? null;

  return Response.json({ error }, { headers: responseHeaders });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Login() {
  const { error: urlError } = useLoaderData<typeof loader>();

  // Magic link state
  const [magicEmail, setMagicEmail] = useState("");
  const [magicSent, setMagicSent] = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [magicError, setMagicError] = useState("");

  // Password login state
  const [pwEmail, setPwEmail] = useState("");
  const [pwPassword, setPwPassword] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");

  async function sendMagicLink() {
    const email = magicEmail.trim().toLowerCase();
    if (!email.includes("@")) {
      setMagicError("Enter a valid email address");
      return;
    }
    setMagicLoading(true);
    setMagicError("");
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: "https://dashboard.sqrz.com/auth/callback" },
      });
      if (error) throw error;
      setMagicSent(true);
    } catch (err) {
      setMagicError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setMagicLoading(false);
    }
  }

  async function loginWithPassword() {
    const email = pwEmail.trim().toLowerCase();
    if (!email.includes("@")) {
      setPwError("Enter a valid email address");
      return;
    }
    if (!pwPassword) {
      setPwError("Enter your password");
      return;
    }
    setPwLoading(true);
    setPwError("");
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password: pwPassword });
      if (error) throw error;
      window.location.href = "/";
    } catch {
      setPwError("Invalid email or password");
    } finally {
      setPwLoading(false);
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

        {/* ── Option 1: Magic link ─────────────────────────────────────────── */}
        <div
          style={{
            background: "#1a1a1a",
            border: "1px solid rgba(245,166,35,0.2)",
            borderRadius: 16,
            padding: "24px",
            marginBottom: 16,
          }}
        >
          <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, marginBottom: 16, marginTop: 0 }}>
            No password needed
          </p>

          {magicSent ? (
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>✉️</div>
              <p style={{ color: "#ffffff", fontWeight: 600, marginBottom: 4, fontSize: 15 }}>
                Check your inbox
              </p>
              <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, marginBottom: 16 }}>
                We sent a magic link to <span style={{ color: "#F5A623" }}>{magicEmail.trim().toLowerCase()}</span>
              </p>
              <button
                onClick={() => { setMagicSent(false); setMagicEmail(""); }}
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
              <input
                type="email"
                value={magicEmail}
                onChange={(e) => setMagicEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMagicLink()}
                placeholder="you@example.com"
                style={inputStyle}
                autoComplete="email"
              />
              {magicError && (
                <p style={{ color: "#ef4444", fontSize: 13, marginTop: -4, marginBottom: 10 }}>
                  {magicError}
                </p>
              )}
              <button
                onClick={sendMagicLink}
                disabled={magicLoading}
                style={{ ...primaryButtonStyle, marginBottom: 0, opacity: magicLoading ? 0.6 : 1 }}
              >
                {magicLoading ? "Sending…" : "Send magic link"}
              </button>
            </>
          )}
        </div>

        {/* ── Divider ──────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px 0" }}>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.1)" }} />
          <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 12 }}>or sign in with password</span>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.1)" }} />
        </div>

        {/* ── Option 2: Email + password ───────────────────────────────────── */}
        <div
          style={{
            background: "#1a1a1a",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16,
            padding: "24px",
            marginBottom: 24,
          }}
        >
          <input
            type="email"
            value={pwEmail}
            onChange={(e) => setPwEmail(e.target.value)}
            placeholder="Email"
            style={inputStyle}
            autoComplete="email"
          />
          <input
            type="password"
            value={pwPassword}
            onChange={(e) => setPwPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && loginWithPassword()}
            placeholder="Password"
            style={{ ...inputStyle, marginBottom: 4 }}
            autoComplete="current-password"
          />

          <div style={{ textAlign: "right", marginBottom: 16 }}>
            <Link
              to="/reset-password"
              style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}
            >
              Forgot password?
            </Link>
          </div>

          {pwError && (
            <p style={{ color: "#ef4444", fontSize: 13, marginTop: 0, marginBottom: 10 }}>
              {pwError}
            </p>
          )}

          <button
            onClick={loginWithPassword}
            disabled={pwLoading}
            style={{ ...secondaryButtonStyle, marginBottom: 0, opacity: pwLoading ? 0.6 : 1 }}
          >
            {pwLoading ? "Logging in…" : "Log in"}
          </button>
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
