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

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "rgba(255,255,255,0.35)",
  fontSize: 13,
  cursor: "pointer",
  padding: 0,
  fontFamily: "inherit",
};

const authLoaderOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background:
    "radial-gradient(circle at 50% 16%, rgba(245, 166, 35, 0.28), transparent 42%), linear-gradient(180deg, #fff5e8 0%, #f7efe1 100%)",
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
  const [code, setCode]               = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading]         = useState(false);
  const [verifying, setVerifying]     = useState(false);
  const [error, setError]             = useState("");
  const [noAccount, setNoAccount]     = useState(false);
  const [codeSent, setCodeSent]       = useState(false);
  const [authPhase, setAuthPhase]     = useState<"idle" | "password" | "code">("idle");

  function toggleMode() {
    setShowPassword((v) => !v);
    setError("");
  }

  function handleEmailChange(value: string) {
    setEmail(value);
    if (noAccount) setNoAccount(false);
  }

  // ── Send a 6-digit OTP code (no magic link, no account creation) ──────────
  async function sendCode() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) { setError("Enter a valid email address"); return; }
    setLoading(true);
    setAuthPhase("code");
    setError("");
    setNoAccount(false);
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { shouldCreateUser: false },
      });
      if (err) throw err;
      setCode("");
      setCodeSent(true);
    } catch {
      // shouldCreateUser:false → unknown emails error out instead of signing up
      setNoAccount(true);
    } finally {
      setLoading(false);
      setAuthPhase("idle");
    }
  }

  // ── Verify the entered code, then route like auth.callback.tsx ────────────
  async function verifyCode() {
    if (code.length !== 6 || verifying) return;
    const trimmed = email.trim().toLowerCase();
    setVerifying(true);
    setError("");
    try {
      const { data, error: err } = await supabase.auth.verifyOtp({
        email: trimmed,
        token: code,
        type: "email",
      });
      if (err) throw err;

      const userId = data.session?.user?.id ?? data.user?.id ?? null;
      let dest = "/";
      if (userId) {
        try {
          const { data: profile } = await supabase
            .from("profiles")
            .select("user_type")
            .eq("user_id", userId)
            .maybeSingle();
          if (profile?.user_type === "guest") {
            const { data: participant } = await supabase
              .from("booking_participants")
              .select("booking_id")
              .eq("user_id", userId)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            dest = participant?.booking_id ? `/booking/${participant.booking_id}` : "/";
          }
        } catch {
          dest = "/";
        }
      }
      window.location.href = dest;
    } catch {
      setError("Invalid or expired code");
      setVerifying(false);
    }
  }

  async function loginWithPassword() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) { setError("Enter a valid email address"); return; }
    if (!password)               { setError("Enter your password"); return; }
    setLoading(true);
    setAuthPhase("password");
    setError("");
    let didRedirect = false;
    try {
      const { error: err } = await supabase.auth.signInWithPassword({ email: trimmed, password });
      if (err) throw err;
      didRedirect = true;
      window.location.href = "/";
    } catch {
      setError("Invalid email or password");
      setAuthPhase("idle");
    } finally {
      if (!didRedirect) {
        setLoading(false);
      }
    }
  }

  function handleSubmit() {
    if (showPassword) {
      loginWithPassword();
      return;
    }
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) { setError("Enter a valid email address"); return; }
    setError("");
    setShowPassword(true);
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
      {loading && (
        <div style={authLoaderOverlayStyle}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 18,
              textAlign: "center",
              color: "#171717",
            }}
          >
            <img
              src="/sqrz-logo-mark.png"
              alt="SQRZ"
              style={{ width: 112, height: 112, objectFit: "contain", display: "block" }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 15, color: "rgba(23,23,23,0.68)" }}>
                {authPhase === "password" ? "Loading..." : "Sending your code..."}
              </div>
            </div>
            <div
              style={{
                width: 54,
                height: 54,
                borderRadius: 999,
                border: "3px solid rgba(23,23,23,0.12)",
                borderTopColor: "#171717",
                animation: "sqrzAuthSpin 900ms linear infinite",
              }}
            />
          </div>
        </div>
      )}
      <div style={{ width: "100%", maxWidth: 420 }}>


        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <img src="/sqrz-logo.png" alt="SQRZ" style={{ height: 40, width: "auto", display: "block", margin: "0 auto" }} />
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
          {codeSent ? (
            /* ── 6-digit code entry ────────────────────────────────────── */
            <div>
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>✉️</div>
                <p style={{ color: "#ffffff", fontWeight: 600, marginBottom: 4, fontSize: 15 }}>
                  Enter the 6-digit code
                </p>
                <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13 }}>
                  We sent a code to{" "}
                  <span style={{ color: "#F5A623" }}>{email.trim().toLowerCase()}</span>
                </p>
              </div>

              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                onKeyDown={(e) => e.key === "Enter" && code.length === 6 && verifyCode()}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                style={{
                  ...inputStyle,
                  textAlign: "center",
                  fontSize: 28,
                  letterSpacing: "0.4em",
                  fontWeight: 700,
                }}
              />

              {error && (
                <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 10, marginTop: -4 }}>
                  {error}
                </p>
              )}

              <button
                onClick={verifyCode}
                disabled={code.length !== 6 || verifying}
                style={{
                  ...primaryButtonStyle,
                  marginBottom: 16,
                  opacity: code.length !== 6 || verifying ? 0.5 : 1,
                  cursor: code.length !== 6 || verifying ? "default" : "pointer",
                }}
              >
                {verifying ? "Verifying…" : "Continue →"}
              </button>

              <div style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "center" }}>
                <button onClick={sendCode} disabled={loading} style={{ ...linkButtonStyle, color: "#F5A623" }}>
                  Resend code
                </button>
                <button
                  onClick={() => { setCodeSent(false); setCode(""); setError(""); }}
                  style={linkButtonStyle}
                >
                  Use a different email
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* ── Email field ─────────────────────────────────────────── */}
              <input
                type="email"
                value={email}
                onChange={(e) => handleEmailChange(e.target.value)}
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
              {noAccount ? (
                <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 10, marginTop: -4 }}>
                  No account found with that email.{" "}
                  <Link to="/join" style={{ color: "#F5A623", textDecoration: "none", fontWeight: 600 }}>
                    Sign up →
                  </Link>
                </p>
              ) : error ? (
                <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 10, marginTop: -4 }}>
                  {error}
                </p>
              ) : null}

              {/* ── Primary CTA ─────────────────────────────────────────── */}
              <button
                onClick={handleSubmit}
                disabled={loading}
                style={{ ...primaryButtonStyle, marginBottom: 16, opacity: loading ? 0.6 : 1 }}
              >
                {loading
                  ? showPassword ? "Logging in…" : "Opening…"
                  : showPassword ? "Login" : "Login with password"}
              </button>

              {/* ── Toggle link ─────────────────────────────────────────── */}
              <div style={{ textAlign: "center" }}>
                <button
                  onClick={showPassword ? toggleMode : sendCode}
                  disabled={loading}
                  style={{ ...linkButtonStyle, opacity: loading ? 0.6 : 1 }}
                >
                  {showPassword ? "Use code instead" : "Send code"}
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
      <style>{`
        @keyframes sqrzAuthSpin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
