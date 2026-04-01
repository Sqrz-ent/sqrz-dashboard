import { useState } from "react";
import { redirect, useLoaderData, useFetcher, useNavigate } from "react-router";
import type { Route } from "./+types/_app.boost";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getPlanLevel, FEATURE_GATES } from "~/lib/plans";
import UpgradeBanner from "~/components/UpgradeBanner";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid rgba(245,166,35,0.28)",
  borderRadius: 16,
  padding: "22px 24px",
  marginBottom: 20,
};

const sectionTitle: React.CSSProperties = {
  fontFamily: FONT_DISPLAY,
  fontSize: 30,
  fontWeight: 800,
  color: ACCENT,
  textTransform: "uppercase" as const,
  letterSpacing: "0.03em",
  margin: "0 0 18px",
  lineHeight: 1.1,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.07em",
  display: "block",
  marginBottom: 8,
};

type Campaign = {
  id: string;
  promote_type: "profile" | "service" | "availability" | "event";
  goal: "visits" | "bookings" | "visibility";
  budget_amount: number;
  budget_currency: string;
  status: "pending" | "preparing" | "live";
  created_at: string;
};

const PROMOTE_OPTIONS = [
  { value: "profile", label: "Profile" },
  { value: "service", label: "Service" },
  { value: "availability", label: "Availability" },
  { value: "event", label: "Event" },
] as const;

const GOAL_OPTIONS = [
  { value: "visits", label: "More Visits" },
  { value: "bookings", label: "More Bookings" },
  { value: "visibility", label: "More Visibility" },
] as const;

const BUDGET_OPTIONS = [
  { value: 50, label: "$50" },
  { value: 100, label: "$100" },
  { value: 150, label: "$150" },
  { value: 300, label: "$300" },
] as const;

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "Pending Payment", color: "#888", bg: "rgba(136,136,136,0.12)" },
  preparing: { label: "Preparing", color: ACCENT, bg: "rgba(245,166,35,0.12)" },
  live: { label: "Live", color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
};

const BOOST_PAYMENT_LINKS: Record<number, string> = {
  50:  "https://buy.stripe.com/test_5kQ28q1Bt1ds8J01QU57W00",
  100: "https://buy.stripe.com/test_7sY7sKbc35tI1gyanq57W01",
  300: "https://buy.stripe.com/test_bJeaEWgwn2hwe3k0MQ57W02",
  500: "https://buy.stripe.com/test_7sY9AScg7f4i8J0cvy57W03",
};

const PROMOTE_LABEL: Record<string, string> = {
  profile: "Profile",
  service: "Service",
  availability: "Availability",
  event: "Event",
};

const GOAL_LABEL: Record<string, string> = {
  visits: "More Visits",
  bookings: "More Bookings",
  visibility: "More Visibility",
};

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const { data: campaigns } = await supabase
    .from("boost_campaigns")
    .select("id, promote_type, goal, budget_amount, budget_currency, status, created_at")
    .eq("profile_id", profile.id as string)
    .in("status", ["pending", "preparing", "live"])
    .order("created_at", { ascending: false });

  return Response.json({ plan_id: (profile.plan_id as number | null) ?? null, is_beta: (profile.is_beta as boolean) ?? false, campaigns: campaigns ?? [], email: (profile.email as string) ?? "" }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const formData = await request.formData();

  const { error } = await supabase.from("boost_campaigns").insert({
    profile_id: profile.id as string,
    promote_type: formData.get("promote_type") as string,
    goal: formData.get("goal") as string,
    budget_amount: parseFloat(formData.get("budget_amount") as string),
    budget_currency: "USD",
    notes: (formData.get("notes") as string) || null,
    status: "pending",
  });

  return Response.json({ ok: !error, error: error?.message }, { headers });
}

export default function BoostPage() {
  const { campaigns, plan_id, is_beta, email } = useLoaderData<typeof loader>() as { campaigns: Campaign[]; plan_id: number | null; is_beta: boolean; email: string };
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const locked = getPlanLevel(plan_id, is_beta) < FEATURE_GATES.boost;

  const [promote, setPromote] = useState<string | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [success, setSuccess] = useState(false);

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data as { ok?: boolean } | undefined;

  if (actionData?.ok && !success) {
    setSuccess(true);
    setPromote(null);
    setGoal(null);
    setBudget(null);
    setNotes("");
  }

  function handleSubmit() {
    if (!promote || !goal || !budget) return;
    setSuccess(false);
    const fd = new FormData();
    fd.append("promote_type", promote);
    fd.append("goal", goal);
    fd.append("budget_amount", String(budget));
    fd.append("notes", notes);
    fetcher.submit(fd, { method: "post" });
  }

  function pillStyle(selected: boolean): React.CSSProperties {
    return {
      padding: "8px 16px",
      borderRadius: 24,
      border: selected ? `1.5px solid ${ACCENT}` : "1.5px solid var(--border)",
      background: selected ? "rgba(245,166,35,0.1)" : "var(--bg)",
      color: selected ? ACCENT : "var(--text-muted)",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer",
      fontFamily: FONT_BODY,
      transition: "all 0.15s",
      whiteSpace: "nowrap" as const,
    };
  }

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>Boost</h1>
      <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: -12, marginBottom: 28 }}>
        Activate targeted attention for your profile
      </p>

      {/* ── Active Campaigns ─────────────────────────────────────────────── */}
      <div style={card}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 16px" }}>
          Active Campaigns
        </h2>

        {campaigns.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No active campaigns</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {campaigns.map((c) => {
              const badge = STATUS_BADGE[c.status] ?? STATUS_BADGE.pending;
              const isPending = c.status === "pending" || c.status === "pending_payment";
              const isPaid = c.status === "live" || c.status === "preparing";
              const baseUrl = BOOST_PAYMENT_LINKS[c.budget_amount] ?? null;
              const paymentUrl = baseUrl ? `${baseUrl}?prefilled_email=${encodeURIComponent(email)}` : null;
              return (
                <div
                  key={c.id}
                  style={{
                    background: "var(--bg)",
                    borderRadius: 12,
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column" as const,
                    gap: 12,
                  }}
                >
                  {/* Campaign header row */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" as const }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                        {PROMOTE_LABEL[c.promote_type]} Boost
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                        {GOAL_LABEL[c.goal]} · ${c.budget_amount} {c.budget_currency}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                        {new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      {isPaid && (
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: "rgba(34,197,94,0.12)", color: "#22c55e" }}>
                          Ad budget paid ✓
                        </span>
                      )}
                      <span style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase" as const,
                        padding: "4px 10px",
                        borderRadius: 20,
                        background: badge.bg,
                        color: badge.color,
                      }}>
                        {badge.label}
                      </span>
                    </div>
                  </div>

                  {/* Ad budget payment section — pending only */}
                  {isPending && (
                    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 10 }}>
                        Ad Budget
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", marginBottom: 12 }}>
                        €{c.budget_amount}
                      </div>
                      <a
                        href={paymentUrl ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => { if (!paymentUrl) e.preventDefault(); }}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "12px",
                          background: paymentUrl ? ACCENT : "var(--surface-muted)",
                          color: paymentUrl ? "#111" : "var(--text-muted)",
                          borderRadius: 10,
                          fontSize: 14,
                          fontWeight: 700,
                          textAlign: "center" as const,
                          textDecoration: "none",
                          cursor: paymentUrl ? "pointer" : "not-allowed",
                          fontFamily: FONT_BODY,
                          boxSizing: "border-box" as const,
                          marginBottom: 8,
                        }}
                      >
                        Pay €{c.budget_amount} →
                      </a>
                      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
                        Ad budget is separate from your SQRZ subscription. It goes directly toward running your campaigns.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Launch Boost form ─────────────────────────────────────────────── */}
      {locked && (
        <UpgradeBanner planName="Boost plan" upgradeParam="boost" />
      )}
      <div style={{ ...card, ...(locked ? { opacity: 0.45, pointerEvents: "none" } : {}) }}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 20px" }}>
          New Boost Campaign
        </h2>

        {success && (
          <div style={{
            background: "rgba(34,197,94,0.1)",
            border: "1px solid rgba(34,197,94,0.3)",
            borderRadius: 10,
            padding: "14px 16px",
            marginBottom: 20,
            fontSize: 14,
            color: "#22c55e",
            lineHeight: 1.5,
          }}>
            Your Boost is being prepared. We'll notify you when it goes live — usually within 24 hours.
          </div>
        )}

        {/* What to promote */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>What do you want to promote?</label>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
            {PROMOTE_OPTIONS.map((o) => (
              <button key={o.value} type="button" onClick={() => setPromote(o.value)} style={pillStyle(promote === o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Goal */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Goal</label>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
            {GOAL_OPTIONS.map((o) => (
              <button key={o.value} type="button" onClick={() => setGoal(o.value)} style={pillStyle(goal === o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Budget */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Budget</label>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
            {BUDGET_OPTIONS.map((o) => (
              <button key={o.value} type="button" onClick={() => setBudget(o.value)} style={pillStyle(budget === o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={"Anything specific you want us to know about\nthis campaign?"}
            style={{
              width: "100%",
              padding: "10px 13px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 14,
              color: "var(--text)",
              outline: "none",
              boxSizing: "border-box" as const,
              fontFamily: FONT_BODY,
              resize: "vertical" as const,
              lineHeight: 1.5,
            }}
          />
        </div>

        {/* Submit */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !promote || !goal || !budget}
          style={{
            width: "100%",
            padding: "14px",
            background: (!promote || !goal || !budget) ? "var(--surface-muted)" : ACCENT,
            color: (!promote || !goal || !budget) ? "var(--text-muted)" : "#111",
            border: "none",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 700,
            cursor: (!promote || !goal || !budget) ? "not-allowed" : "pointer",
            fontFamily: FONT_BODY,
            letterSpacing: "0.02em",
            transition: "background 0.15s",
          }}
        >
          {isSubmitting ? "Activating…" : "Activate Boost →"}
        </button>
      </div>
    </div>
  );
}
