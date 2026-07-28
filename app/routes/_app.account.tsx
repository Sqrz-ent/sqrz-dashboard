import { useState } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.account";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase } from "~/lib/supabase.client";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid rgba(245,166,35,0.28)",
  borderRadius: 16,
  padding: "22px 24px",
  marginBottom: 20,
  position: "relative",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.07em",
  display: "block",
  marginBottom: 4,
  fontFamily: FONT_BODY,
};

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  return Response.json(
    {
      profile,
    },
    { headers }
  );
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "sign_out") {
    await supabase.auth.signOut();
    return redirect("/login", { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

export default function AccountPage() {
  const { profile } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
  };

  const signOutFetcher = useFetcher();

  const [newPassword, setNewPassword]       = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError]   = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  async function handleSetPassword() {
    setPasswordError("");
    setPasswordSuccess(false);
    if (newPassword.length < 8) { setPasswordError("Password must be at least 8 characters"); return; }
    if (newPassword !== confirmPassword) { setPasswordError("Passwords don't match"); return; }
    setPasswordLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setPasswordSuccess(true);
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to set password");
    } finally {
      setPasswordLoading(false);
    }
  }

  const slug = (profile.slug as string) ?? "";

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 30,
        fontWeight: 800,
        color: ACCENT,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "0 0 28px",
        lineHeight: 1.1,
      }}>
        Account
      </h1>

      {/* Card 1: Username */}
      <div style={card}>
        <span style={labelStyle}>Your handle</span>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY, marginBottom: 6 }}>
          @{slug}
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, fontFamily: FONT_BODY }}>
          Read-only for now
        </p>
      </div>

      {/* Card 2: Password */}
      <div style={card}>
        <span style={labelStyle}>Set a Password</span>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", fontFamily: FONT_BODY }}>
          Set a password so you can log in without a magic link
        </p>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password"
          minLength={8}
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "var(--surface-muted)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 15,
            color: "var(--text)",
            outline: "none",
            marginBottom: 10,
            boxSizing: "border-box",
            fontFamily: FONT_BODY,
          }}
        />
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Confirm password"
          minLength={8}
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "var(--surface-muted)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 15,
            color: "var(--text)",
            outline: "none",
            marginBottom: 12,
            boxSizing: "border-box",
            fontFamily: FONT_BODY,
          }}
        />
        {passwordError && (
          <p style={{ fontSize: 13, color: "#ef4444", margin: "0 0 10px", fontFamily: FONT_BODY }}>
            {passwordError}
          </p>
        )}
        {passwordSuccess && (
          <p style={{ fontSize: 13, color: "#22c55e", margin: "0 0 10px", fontFamily: FONT_BODY }}>
            Password set successfully
          </p>
        )}
        <button
          onClick={handleSetPassword}
          disabled={passwordLoading}
          style={{
            padding: "10px 22px",
            background: ACCENT,
            color: "#fff",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: FONT_BODY,
            opacity: passwordLoading ? 0.6 : 1,
          }}
        >
          {passwordLoading ? "Saving…" : "Set Password"}
        </button>
      </div>

      {/* Card 3: Sign Out */}
      <div style={card}>
        <span style={labelStyle}>Session</span>
        <signOutFetcher.Form method="post">
          <input type="hidden" name="intent" value="sign_out" />
          <button
            type="submit"
            disabled={signOutFetcher.state !== "idle"}
            style={{
              padding: "10px 22px",
              background: "rgba(239,68,68,0.1)",
              color: "#ef4444",
              border: "1px solid rgba(239,68,68,0.25)",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FONT_BODY,
              display: "block",
              marginBottom: 8,
            }}
          >
            {signOutFetcher.state !== "idle" ? "Signing out…" : "Sign out →"}
          </button>
        </signOutFetcher.Form>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, fontFamily: FONT_BODY }}>
          You'll be signed out of this device.
        </p>
      </div>
    </div>
  );
}
