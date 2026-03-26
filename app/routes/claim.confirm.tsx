import { redirect } from "react-router";
import type { Route } from "./+types/claim.confirm";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";

const FONT = "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const claimToken = url.searchParams.get("claim_token") ?? "";
  const slug = url.searchParams.get("slug") ?? "";

  const { supabase, headers } = createSupabaseServerClient(request);

  // Must be authenticated (magic link was just clicked)
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return redirect("/login", { headers });
  }

  if (!claimToken || !slug) {
    return Response.json({ error: "invalid_params" }, { headers });
  }

  const admin = createSupabaseAdminClient();

  // Verify the claim token matches an unclaimed profile
  const { data: profile } = await admin
    .from("profiles")
    .select("id, slug, claim_token, is_claimed, user_id, referred_by_code")
    .eq("slug", slug)
    .eq("claim_token", claimToken)
    .eq("is_claimed", false)
    .maybeSingle();

  if (!profile) {
    return Response.json({ error: "invalid_token" }, { headers });
  }

  // Claim the profile
  const { error: updateError } = await admin
    .from("profiles")
    .update({
      user_id: user.id,
      is_claimed: true,
      claimed_at: new Date().toISOString(),
      is_published: true,
      claim_token: null,
      // Only set if no referral already applied — grants Early Access discount at checkout
      ...(profile.referred_by_code == null ? { referred_by_code: "claim" } : {}),
    })
    .eq("id", profile.id);

  if (updateError) {
    return Response.json({ error: "update_failed" }, { headers });
  }

  // Redirect to dashboard with welcome flag
  return redirect("/?claimed=1", { headers });
}

export default function ClaimConfirm({
  loaderData,
}: {
  loaderData: { error?: string };
}) {
  const { error } = loaderData ?? {};

  // Success: this page is typically not shown — loader redirects on success.
  // Shown only when there's an error.

  const messages: Record<string, { title: string; body: string }> = {
    invalid_params: {
      title: "Invalid link",
      body: "This claim link is missing required parameters. Please use the link from your email.",
    },
    invalid_token: {
      title: "Link already used or invalid",
      body: "This profile has already been claimed or the link has expired. If this is your profile, please contact support.",
    },
    update_failed: {
      title: "Something went wrong",
      body: "We couldn't complete the claim. Please try again or contact support.",
    },
  };

  const msg = error ? (messages[error] ?? messages.update_failed) : null;

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
        <div style={{ marginBottom: 28 }}>
          <span style={{ fontSize: 22, fontWeight: 800, color: "#fff", letterSpacing: "0.2em" }}>
            [<span style={{ color: ACCENT }}> SQRZ </span>]
          </span>
        </div>

        {msg ? (
          <>
            <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ fontSize: 22, fontWeight: 800, color: "#fff", margin: "0 0 10px" }}>
              {msg.title}
            </h2>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", margin: "0 0 24px", lineHeight: 1.6 }}>
              {msg.body}
            </p>
            <a
              href="/"
              style={{
                display: "inline-block",
                padding: "12px 24px",
                background: ACCENT,
                color: "#111",
                fontWeight: 700,
                fontSize: 14,
                borderRadius: 12,
                textDecoration: "none",
                fontFamily: FONT,
              }}
            >
              Go to Dashboard
            </a>
          </>
        ) : (
          // Fallback while redirect fires (rarely shown)
          <>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🎉</div>
            <h2 style={{ fontSize: 22, fontWeight: 800, color: "#fff", margin: "0 0 10px" }}>
              Profile claimed!
            </h2>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", margin: "0 0 24px", lineHeight: 1.6 }}>
              Your profile is live. Welcome to SQRZ.
            </p>
            <a
              href="/"
              style={{
                display: "inline-block",
                padding: "12px 24px",
                background: ACCENT,
                color: "#111",
                fontWeight: 700,
                fontSize: 14,
                borderRadius: 12,
                textDecoration: "none",
                fontFamily: FONT,
              }}
            >
              Go to Dashboard →
            </a>
          </>
        )}
      </div>
    </div>
  );
}
