import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.account";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

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

  const [subRes, planRes] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("*")
      .eq("profile_id", profile.id as string)
      .eq("status", "active")
      .order("current_period_end", { ascending: false })
      .limit(1)
      .maybeSingle(),
    profile.plan_id
      ? supabase
          .from("plans")
          .select("id, name")
          .eq("id", profile.plan_id as number)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return Response.json(
    {
      profile,
      subscription: subRes.data ?? null,
      plan: planRes.data ?? null,
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

function StatusBadge({ status }: { status: string }) {
  let bg = "rgba(245,166,35,0.12)";
  let color = ACCENT;
  let label = status;

  if (status === "active") {
    bg = "rgba(34,197,94,0.12)";
    color = "#22c55e";
    label = "Active";
  } else if (status === "past_due") {
    bg = "rgba(245,166,35,0.12)";
    color = ACCENT;
    label = "Past Due";
  } else if (status === "canceled" || status === "cancelled") {
    bg = "rgba(239,68,68,0.12)";
    color = "#ef4444";
    label = "Cancelled";
  }

  return (
    <span style={{
      display: "inline-block",
      padding: "3px 10px",
      background: bg,
      borderRadius: 8,
      fontSize: 11,
      fontWeight: 700,
      color,
      fontFamily: FONT_BODY,
      letterSpacing: "0.04em",
    }}>
      {label}
    </span>
  );
}

export default function AccountPage() {
  const { profile, subscription, plan } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
    subscription: Record<string, unknown> | null;
    plan: { id: number; name: string } | null;
  };

  const signOutFetcher = useFetcher();

  const slug = (profile.slug as string) ?? "";
  const planName = plan?.name ?? (profile.plan_id ? `Plan ${profile.plan_id}` : null);

  const renewDate = subscription?.current_period_end
    ? new Date(subscription.current_period_end as string).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY, display: "block", marginBottom: 6 }}>
              Password
            </span>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, fontFamily: FONT_BODY }}>
              You'll be able to update your password here soon.
            </p>
          </div>
          <span style={{
            padding: "4px 10px",
            background: "rgba(245,166,35,0.1)",
            border: "1px solid rgba(245,166,35,0.2)",
            borderRadius: 8,
            fontSize: 11,
            fontWeight: 700,
            color: "var(--text-muted)",
            fontFamily: FONT_BODY,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}>
            Coming soon
          </span>
        </div>
      </div>

      {/* Card 3: Subscription */}
      <div style={card}>
        <span style={labelStyle}>Subscription</span>
        {subscription && planName ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY }}>
                {planName}
              </span>
              <StatusBadge status={subscription.status as string} />
            </div>
            {renewDate && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, fontFamily: FONT_BODY }}>
                Renews on {renewDate}
              </p>
            )}
          </div>
        ) : planName ? (
          <div>
            <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY, display: "block", marginBottom: 4 }}>
              {planName}
            </span>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, fontFamily: FONT_BODY }}>
              Active plan (no subscription record found)
            </p>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px", fontFamily: FONT_BODY }}>
              No active plan
            </p>
            <a
              href="/upgrade"
              style={{
                display: "inline-block",
                padding: "10px 22px",
                background: ACCENT,
                color: "#111",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 700,
                textDecoration: "none",
                fontFamily: FONT_BODY,
              }}
            >
              Upgrade →
            </a>
          </div>
        )}
      </div>

      {/* Card 4: Sign Out */}
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
