import { useEffect, useState } from "react";
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

  const url = new URL(request.url);
  const error = url.searchParams.get("error") ?? null;

  // A signed-in user is bounced to "/". Exception: when we were sent here WITH
  // an error (e.g. a session whose account has no profile — "/" redirects
  // here), render the page instead, otherwise "/" ↔ "/login" would loop.
  if (user && !error) return redirect("/", { headers });

  return Response.json({ error }, { headers });
}

// ─── Error classification ─────────────────────────────────────────────────────

const RESEND_COOLDOWN_SECONDS = 60;

type AuthLikeError = { message?: string; status?: number; code?: string; name?: string };

function asAuthError(err: unknown): AuthLikeError {
  return (err && typeof err === "object" ? err : {}) as AuthLikeError;
}

function isRateLimit(e: AuthLikeError): boolean {
  return (
    e.status === 429 ||
    e.code === "over_email_send_rate_limit" ||
    e.code === "over_request_rate_limit" ||
    /rate limit|too many/i.test(e.message ?? "")
  );
}

function isNetworkError(e: AuthLikeError): boolean {
  return e.name === "AuthRetryableFetchError" || e.status === 0 || e.name === "TypeError";
}

// signInWithOtp with shouldCreateUser:false rejects an unknown email with a
// "signups not allowed" error. That must look identical to success (no account
// enumeration), so it is classified separately and never shown to the user.
function isUnknownUserError(e: AuthLikeError): boolean {
  return (
    e.code === "otp_disabled" ||
    e.code === "signup_disabled" ||
    e.code === "user_not_found" ||
    /signups? not allowed|user not found/i.test(e.message ?? "")
  );
}

function sendErrorMessage(e: AuthLikeError): string {
  if (isRateLimit(e)) {
    return "Too many code requests. Please wait a minute and try again.";
  }
  if (isNetworkError(e)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return "We couldn't send the email right now. Please try again in a moment.";
}

function verifyErrorMessage(e: AuthLikeError): string {
  if (isRateLimit(e)) return "Too many attempts. Please wait a minute and try again.";
  if (isNetworkError(e)) return "Couldn't reach the server. Check your connection and try again.";
  if (e.code === "otp_expired" || /expired/i.test(e.message ?? "")) {
    return "That code has expired. Request a new one.";
  }
  if ((e.status ?? 0) >= 500) return "Something went wrong on our side. Please try again.";
  return "That code isn't right. Check it and try again.";
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Login() {
  const { error: urlError } = useLoaderData<typeof loader>();

  const [email, setEmail]               = useState("");
  const [password, setPassword]         = useState("");
  const [code, setCode]                 = useState("");
  const [usePassword, setUsePassword]   = useState(false);
  const [loading, setLoading]           = useState(false);
  const [verifying, setVerifying]       = useState(false);
  const [error, setError]               = useState("");
  const [codeSent, setCodeSent]         = useState(false);
  const [cooldown, setCooldown]         = useState(0);
  const [authPhase, setAuthPhase]       = useState<"idle" | "password" | "code">("idle");

  // Resend cooldown: counts down once per second.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const normalizedEmail = email.trim().toLowerCase();

  // ── Send a 6-digit OTP code (no magic link, never creates an account) ─────
  async function sendCode() {
    if (loading || cooldown > 0) return;
    if (!normalizedEmail.includes("@")) { setError("Enter a valid email address"); return; }
    setLoading(true);
    setAuthPhase("code");
    setError("");
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: normalizedEmail,
        options: { shouldCreateUser: false },
      });
      if (err) throw err;
      setCode("");
      setCodeSent(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (raw) {
      const e = asAuthError(raw);
      if (isUnknownUserError(e)) {
        // Neutral: behave exactly like a successful send.
        setCode("");
        setCodeSent(true);
        setCooldown(RESEND_COOLDOWN_SECONDS);
      } else {
        // Real failure (rate limit, SMTP/send failure, network): say so.
        setError(sendErrorMessage(e));
        if (isRateLimit(e)) setCooldown(RESEND_COOLDOWN_SECONDS);
      }
    } finally {
      setLoading(false);
      setAuthPhase("idle");
    }
  }

  // ── Verify the entered code; the cookie session is set by the browser client
  async function verifyCode() {
    if (code.length !== 6 || verifying) return;
    setVerifying(true);
    setError("");
    try {
      const { error: err } = await supabase.auth.verifyOtp({
        email: normalizedEmail,
        token: code,
        type: "email",
      });
      if (err) throw err;

      window.location.href = "/";
    } catch (raw) {
      setError(verifyErrorMessage(asAuthError(raw)));
      setVerifying(false);
    }
  }

  async function loginWithPassword() {
    if (loading) return;
    if (!normalizedEmail.includes("@")) { setError("Enter a valid email address"); return; }
    if (!password)                      { setError("Enter your password"); return; }
    setLoading(true);
    setAuthPhase("password");
    setError("");
    let didRedirect = false;
    try {
      const { error: err } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
      if (err) throw err;
      didRedirect = true;
      window.location.href = "/";
    } catch (raw) {
      const e = asAuthError(raw);
      if (isRateLimit(e)) setError("Too many attempts. Please wait a minute and try again.");
      else if (isNetworkError(e)) setError("Couldn't reach the server. Check your connection and try again.");
      else setError("Invalid email or password");
      setAuthPhase("idle");
    } finally {
      if (!didRedirect) {
        setLoading(false);
      }
    }
  }

  function switchMode(toPassword: boolean) {
    setUsePassword(toPassword);
    setError("");
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
                <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, lineHeight: 1.5 }}>
                  If <span style={{ color: "#F5A623" }}>{normalizedEmail}</span> has an SQRZ
                  account, we've sent a code.
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
                <p role="alert" style={{ color: "#ef4444", fontSize: 13, marginBottom: 10, marginTop: -4 }}>
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
                <button
                  onClick={sendCode}
                  disabled={loading || cooldown > 0}
                  style={{
                    ...linkButtonStyle,
                    color: cooldown > 0 ? "rgba(255,255,255,0.35)" : "#F5A623",
                    cursor: loading || cooldown > 0 ? "default" : "pointer",
                  }}
                >
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
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
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (usePassword) loginWithPassword(); else sendCode();
                }}
                placeholder="you@example.com"
                style={inputStyle}
                autoComplete="email"
                autoFocus
              />

              {/* ── Password field — only in the secondary password mode ─── */}
              {usePassword && (
                <div>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && loginWithPassword()}
                    placeholder="Password"
                    style={inputStyle}
                    autoComplete="current-password"
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
              )}

              {/* ── Error ───────────────────────────────────────────────── */}
              {error && (
                <p role="alert" style={{ color: "#ef4444", fontSize: 13, marginBottom: 10, marginTop: -4 }}>
                  {error}
                </p>
              )}

              {/* ── Primary CTA ─────────────────────────────────────────── */}
              <button
                onClick={usePassword ? loginWithPassword : sendCode}
                disabled={loading || (!usePassword && cooldown > 0)}
                style={{
                  ...primaryButtonStyle,
                  marginBottom: 16,
                  opacity: loading || (!usePassword && cooldown > 0) ? 0.6 : 1,
                }}
              >
                {usePassword
                  ? loading ? "Logging in…" : "Log in"
                  : loading
                    ? "Sending…"
                    : cooldown > 0
                      ? `Try again in ${cooldown}s`
                      : "Email me a login code"}
              </button>

              {/* ── Secondary link ──────────────────────────────────────── */}
              <div style={{ textAlign: "center" }}>
                <button
                  onClick={() => switchMode(!usePassword)}
                  disabled={loading}
                  style={{ ...linkButtonStyle, opacity: loading ? 0.6 : 1 }}
                >
                  {usePassword ? "Email me a code instead" : "Use password instead"}
                </button>
              </div>
            </>
          )}
        </div>

        <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, textAlign: "center", lineHeight: 1.5 }}>
          SQRZ accounts are created in the SQRZ iOS app.
          <br />
          Lost your iPhone? Use an emailed code to get back in.
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
