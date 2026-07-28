import { redirect } from "react-router";
import type { Route } from "./+types/_app.invite-onboarding";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

const ACCENT = "#F5A623";
const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  padding: "28px",
};

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const inviteStatus = profile.partner_invite_status as string | null;
  if (inviteStatus !== "invited") return redirect("/office", { headers });

  return Response.json({ ok: true }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "accept") {
    await supabase
      .from("profiles")
      .update({
        is_partner: true,
        partner_invite_status: "accepted",
        partner_tos_accepted_at: new Date().toISOString(),
      })
      .eq("id", profile.id as string);

    return redirect("/invites", { headers });
  }

  if (intent === "decline") {
    await supabase
      .from("profiles")
      .update({ partner_invite_status: "declined" })
      .eq("id", profile.id as string);
  }

  return redirect("/office", { headers });
}

export default function InviteOnboarding() {
  return (
    <div
      style={{
        maxWidth: 600,
        margin: "0 auto",
        padding: "40px 20px 100px",
        fontFamily: FONT_BODY,
        color: "var(--text)",
      }}
    >
      <div style={card}>
        <div style={{ fontSize: 28, marginBottom: 16, color: ACCENT }}>Invite Only</div>
        <h1
          style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 32,
            fontWeight: 800,
            color: ACCENT,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            margin: "0 0 16px",
            lineHeight: 1.1,
          }}
        >
          Help shape the SQRZ iOS beta
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: "var(--text)", margin: "0 0 12px" }}>
          SQRZ is invite-only while the iOS experience is still forming. Accepting this invite gives
          you an invite link for people you trust to test the product.
        </p>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-muted)", margin: "0 0 22px" }}>
          The invite link is for access only. The current beta is about trusted distribution,
          feedback, and learning who should be inside the network.
        </p>

        <form method="post" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="submit"
            name="intent"
            value="accept"
            style={{
              width: "100%",
              padding: "13px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FONT_BODY,
            }}
          >
            Activate beta invites
          </button>
          <button
            type="submit"
            name="intent"
            value="decline"
            style={{
              width: "100%",
              padding: "11px",
              background: "none",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FONT_BODY,
            }}
          >
            Not now
          </button>
        </form>
      </div>
    </div>
  );
}
