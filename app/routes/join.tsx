import { useState, useEffect } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/join";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { supabase } from "~/lib/supabase.client";

type Step = "username" | "email" | "sent";
type SlugStatus = "idle" | "checking" | "available" | "taken";

type Template = {
  id: string;
  name: string;
  css_file: string;
  preview_image: string | null;
};

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  background: "#1a1a1a",
  border: "1px solid rgba(245,166,35,0.3)",
  borderRadius: 12,
  fontSize: 16,
  color: "#ffffff",
  outline: "none",
  marginBottom: 16,
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

const backButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "rgba(255,255,255,0.4)",
  cursor: "pointer",
  fontSize: 14,
  padding: 0,
  marginBottom: 20,
};

const ghostButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 14,
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ErrorMessage({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p style={{ color: "#ef4444", fontSize: 13, marginTop: -8, marginBottom: 12 }}>
      {message}
    </p>
  );
}

function UsernameStep({
  slug,
  onSlugChange,
  slugStatus,
  onSubmit,
  onLoginClick,
}: {
  slug: string;
  onSlugChange: (v: string) => void;
  slugStatus: SlugStatus;
  onSubmit: () => void;
  onLoginClick: () => void;
}) {
  const canContinue = slugStatus === "available";

  const statusLabel =
    slug.length > 0 && slug.length < 3
      ? { text: "At least 3 characters", color: "rgba(255,255,255,0.3)" }
      : slugStatus === "checking"
      ? { text: "Checking…", color: "rgba(255,255,255,0.35)" }
      : slugStatus === "available"
      ? { text: `✓ ${slug}.sqrz.com is available`, color: "#4ade80" }
      : slugStatus === "taken"
      ? { text: "Already taken, try another", color: "#ef4444" }
      : null;

  return (
    <div>
      <h1
        style={{
          color: "#ffffff",
          fontSize: 26,
          fontWeight: 800,
          marginBottom: 8,
          letterSpacing: "-0.5px",
          lineHeight: 1.2,
        }}
      >
        THE LINKINBIO THAT
        <br />
        GETS YOU BOOKED.
      </h1>
      <p style={{ color: "rgba(255,255,255,0.45)", marginBottom: 32, fontSize: 14 }}>
        Your professional home on the web.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "#1a1a1a",
          border: `1px solid ${
            slugStatus === "available"
              ? "rgba(74,222,128,0.5)"
              : slugStatus === "taken"
              ? "rgba(239,68,68,0.5)"
              : "rgba(245,166,35,0.3)"
          }`,
          borderRadius: 12,
          padding: "0 16px",
          marginBottom: 8,
          transition: "border-color 0.2s",
        }}
      >
        <input
          value={slug}
          onChange={(e) =>
            onSlugChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
          }
          onKeyDown={(e) => e.key === "Enter" && canContinue && onSubmit()}
          placeholder="yourname"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#ffffff",
            fontSize: 16,
            padding: "14px 0",
          }}
        />
        <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 14, whiteSpace: "nowrap" }}>
          .sqrz.com
        </span>
      </div>

      {statusLabel && (
        <p style={{ fontSize: 13, color: statusLabel.color, marginBottom: 12, marginTop: 0 }}>
          {statusLabel.text}
        </p>
      )}

      <button
        onClick={onSubmit}
        disabled={!canContinue}
        style={{
          ...primaryButtonStyle,
          marginTop: 8,
          opacity: canContinue ? 1 : 0.35,
          cursor: canContinue ? "pointer" : "default",
        }}
      >
        Continue →
      </button>

      <p
        style={{
          textAlign: "center",
          marginTop: 20,
          color: "rgba(255,255,255,0.4)",
          fontSize: 14,
        }}
      >
        Already have an account?{" "}
        <button
          onClick={onLoginClick}
          style={{ ...ghostButtonStyle, color: "#F5A623" }}
        >
          Log in →
        </button>
      </p>
    </div>
  );
}

function EmailStep({
  slug,
  email,
  setEmail,
  onSubmit,
  onBack,
  error,
  loading,
}: {
  slug: string;
  email: string;
  setEmail: (v: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  error: string;
  loading: boolean;
}) {
  return (
    <div>
      <button onClick={onBack} style={backButtonStyle}>
        ← Back
      </button>

      <div style={{ marginBottom: 24 }}>
        <p style={{ color: "#F5A623", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          ✓ {slug}.sqrz.com is yours!
        </p>
        <h2 style={{ color: "#ffffff", fontSize: 22, fontWeight: 700, margin: 0 }}>
          Enter your email
        </h2>
      </div>

      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        style={inputStyle}
        autoFocus
      />

      <ErrorMessage message={error} />

      <button onClick={onSubmit} disabled={loading} style={primaryButtonStyle}>
        {loading ? "Sending…" : "Send magic link"}
      </button>
    </div>
  );
}

function SentStep({
  email,
  onResend,
  onChangeEmail,
  loading,
}: {
  email: string;
  onResend: () => void;
  onChangeEmail: () => void;
  loading: boolean;
}) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 52, marginBottom: 16 }}>✉️</div>
      <h2 style={{ color: "#ffffff", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        Check your email
      </h2>
      <p style={{ color: "rgba(255,255,255,0.5)", marginBottom: 4, fontSize: 15 }}>
        We sent a magic link to
      </p>
      <p style={{ color: "#F5A623", fontWeight: 600, marginBottom: 24, fontSize: 15 }}>
        {email}
      </p>
      <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, marginBottom: 28 }}>
        Click the link in your email to access your dashboard.
      </p>

      <button
        onClick={onResend}
        disabled={loading}
        style={{ ...ghostButtonStyle, color: "#F5A623", display: "block", margin: "0 auto 14px" }}
      >
        {loading ? "Sending…" : "Resend email"}
      </button>
      <button
        onClick={onChangeEmail}
        style={{ ...ghostButtonStyle, color: "rgba(255,255,255,0.35)" }}
      >
        Use a different email
      </button>
    </div>
  );
}

// ─── Action — slug availability check (fires on every keystroke via useFetcher) ──

export async function action({ request }: Route.ActionArgs) {
  const { supabase: supabaseServer } = createSupabaseServerClient(request);
  const formData = await request.formData();
  const slug = (formData.get("slug") as string ?? "").trim().toLowerCase();

  if (!slug || slug.length < 3) {
    return Response.json({ available: false });
  }

  const { data } = await supabaseServer
    .from("profiles")
    .select("slug")
    .eq("slug", slug)
    .maybeSingle();

  return Response.json({ available: !data });
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase: supabaseServer } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabaseServer.auth.getUser();

  if (user) return redirect("/");

  const url = new URL(request.url);

  const { data: templates } = await supabaseServer
    .from("templates")
    .select("id, name, css_file, preview_image")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  // Validate optional referral code from URL
  const refParam = url.searchParams.get("ref") ?? "";
  let refValid = false;
  if (refParam) {
    const admin = createSupabaseAdminClient();
    const now = new Date().toISOString();
    const { data: refRow } = await admin
      .from("referral_codes")
      .select("id, max_uses, use_count")
      .eq("code", refParam)
      .eq("is_active", true)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .maybeSingle();
    if (refRow) {
      refValid = refRow.max_uses == null || (refRow.use_count ?? 0) < refRow.max_uses;
    }
  }

  return {
    initialSlug: url.searchParams.get("slug") ?? "",
    templates: (templates ?? []) as Template[],
    refCode: refValid ? refParam : "",
    refValid,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Join() {
  const { initialSlug, refCode, refValid } = useLoaderData<typeof loader>();

  const [step, setStep] = useState<Step>("username");
  const [phase, setPhase] = useState<"in" | "out">("in");

  const [slug, setSlug] = useState(initialSlug);
  const [email, setEmail] = useState("");

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Slug availability via useFetcher — fires on every keystroke
  const slugFetcher = useFetcher<{ available: boolean }>();

  // If handle was pre-filled from URL param (?slug=...), trigger availability check on mount
  useEffect(() => {
    if (initialSlug.length >= 3) {
      slugFetcher.submit({ slug: initialSlug }, { method: "POST" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only

  const slugStatus: SlugStatus =
    slug.length < 3
      ? "idle"
      : slugFetcher.state !== "idle"
      ? "checking"
      : slugFetcher.data?.available === true
      ? "available"
      : slugFetcher.data?.available === false
      ? "taken"
      : "idle";

  function handleSlugChange(val: string) {
    setSlug(val);
    if (val.length >= 3) {
      slugFetcher.submit({ slug: val }, { method: "POST" });
    }
  }

  function goTo(nextStep: Step) {
    setPhase("out");
    setError("");
    setTimeout(() => {
      setStep(nextStep);
      setPhase("in");
    }, 180);
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function sendMagicLink() {
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@")) {
      setError("Enter a valid email address");
      return;
    }
    setLoading(true);
    setError("");
    try {
      // Persist handle and ref in cookies before the user leaves the site via magic link
      const expires = new Date(Date.now() + 3600 * 1000).toUTCString();
      document.cookie = `sqrz_pending_handle=${encodeURIComponent(slug)}; path=/; expires=${expires}; SameSite=Lax`;
      if (refCode) {
        document.cookie = `sqrz_pending_ref=${encodeURIComponent(refCode)}; path=/; expires=${expires}; SameSite=Lax`;
      }

      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: normalized,
        options: {
          emailRedirectTo: "https://dashboard.sqrz.com/auth/callback",
        },
      });
      if (otpError) throw otpError;
      setEmail(normalized);
      goTo("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

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

        {/* Referral banner */}
        {refValid && (
          <div
            style={{
              background: "rgba(74,222,128,0.08)",
              border: "1px solid rgba(74,222,128,0.25)",
              borderRadius: 10,
              padding: "10px 16px",
              marginBottom: 24,
              textAlign: "center",
              fontSize: 13,
              color: "#4ade80",
              fontWeight: 500,
            }}
          >
            🎉 Early Access invite applied
          </div>
        )}

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <span
            style={{ color: "#ffffff", fontSize: 20, fontWeight: 800, letterSpacing: "0.25em" }}
          >
            [<span style={{ color: "#F5A623" }}> SQRZ </span>]
          </span>
        </div>

        {/* State machine */}
        <div
          style={{
            opacity: phase === "in" ? 1 : 0,
            transform: phase === "in" ? "translateY(0)" : "translateY(8px)",
            transition: "opacity 0.18s ease, transform 0.18s ease",
          }}
        >
          {step === "username" && (
            <UsernameStep
              slug={slug}
              onSlugChange={handleSlugChange}
              slugStatus={slugStatus}
              onSubmit={() => goTo("email")}
              onLoginClick={() => goTo("email")}
            />
          )}

          {step === "email" && (
            <EmailStep
              slug={slug}
              email={email}
              setEmail={setEmail}
              onSubmit={sendMagicLink}
              onBack={() => goTo("username")}
              error={error}
              loading={loading}
            />
          )}

          {step === "sent" && (
            <SentStep
              email={email}
              onResend={sendMagicLink}
              onChangeEmail={() => goTo("email")}
              loading={loading}
            />
          )}
        </div>
      </div>
    </div>
  );
}
