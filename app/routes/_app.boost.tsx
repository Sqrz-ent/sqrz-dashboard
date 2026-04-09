import { useState, useEffect } from "react";
import { redirect, useLoaderData, useFetcher, useSearchParams } from "react-router";
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

type PrivateLink = {
  id: string;
  label: string | null;
  link_slug: string;
  page_type: string;
};

type Campaign = {
  id: string;
  promote_type: string;
  promote_link_id: string | null;
  target_audience: string | null;
  budget_amount: number;
  budget_currency: string;
  status: "draft" | "pending" | "preparing" | "live";
  created_at: string;
};

const BUDGET_OPTIONS = [
  { value: 50, label: "$50" },
  { value: 100, label: "$100" },
  { value: 150, label: "$150" },
  { value: 300, label: "$300" },
] as const;

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: "Draft", color: "#888", bg: "rgba(136,136,136,0.12)" },
  pending: { label: "Pending Payment", color: "#888", bg: "rgba(136,136,136,0.12)" },
  preparing: { label: "Preparing", color: ACCENT, bg: "rgba(245,166,35,0.12)" },
  live: { label: "Live", color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
};

const BOOST_PAYMENT_LINKS: Record<number, string> = {
  50:  "https://buy.stripe.com/7sY7sKbc35tI1gyanq57W01",
  100: "https://buy.stripe.com/bJeaEWgwn2hwe3k0MQ57W02",
  150: "https://buy.stripe.com/7sY9AScg7f4i8J0cvy57W03",
  300: "https://buy.stripe.com/eVq14m6VN3lA9N4dzC57W04",
};

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const [{ data: campaigns }, { data: privateLinks }] = await Promise.all([
    supabase
      .from("boost_campaigns")
      .select("id, promote_type, promote_link_id, target_audience, budget_amount, budget_currency, status, created_at")
      .eq("profile_id", profile.id as string)
      .in("status", ["draft", "pending", "preparing", "live"])
      .order("created_at", { ascending: false }),
    supabase
      .from("private_booking_links")
      .select("id, label, link_slug, page_type")
      .eq("profile_id", profile.id as string)
      .eq("is_active", true),
  ]);

  return Response.json(
    {
      plan_id: (profile.plan_id as number | null) ?? null,
      is_beta: (profile.is_beta as boolean) ?? false,
      grow_qualified: (profile.grow_qualified as boolean) ?? false,
      campaigns: campaigns ?? [],
      privateLinks: privateLinks ?? [],
      email: (profile.email as string) ?? "",
      profile_id: profile.id as string,
    },
    { headers }
  );
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const formData = await request.formData();
  const promoteType = formData.get("promote_type") as string;
  const promoteLinkId = formData.get("promote_link_id") as string | null;

  const { error } = await supabase.from("boost_campaigns").insert({
    profile_id: profile.id as string,
    promote_type: promoteType,
    promote_link_id: promoteType === "link" && promoteLinkId ? promoteLinkId : null,
    target_audience: (formData.get("target_audience") as string) || null,
    budget_amount: parseFloat(formData.get("budget_amount") as string),
    budget_currency: "USD",
    notes: (formData.get("notes") as string) || null,
    status: "draft",
  });

  return Response.json({ ok: !error, error: error?.message }, { headers });
}

export default function BoostPage() {
  const { campaigns, privateLinks, plan_id, is_beta, grow_qualified, email } = useLoaderData<typeof loader>() as {
    campaigns: Campaign[];
    privateLinks: PrivateLink[];
    plan_id: number | null;
    is_beta: boolean;
    grow_qualified: boolean;
    email: string;
    profile_id: string;
  };
  const fetcher = useFetcher();
  const [searchParams] = useSearchParams();
  const locked = getPlanLevel(plan_id, is_beta) < FEATURE_GATES.boost;

  const [promoteType, setPromoteType] = useState<string | null>(null);
  const [promoteLinkId, setPromoteLinkId] = useState<string>("");
  const [targetAudience, setTargetAudience] = useState("");
  const [budget, setBudget] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [success, setSuccess] = useState(false);

  // Grow section state
  const [growBudget, setGrowBudget] = useState(1000);
  const [growLoading, setGrowLoading] = useState(false);
  const [growError, setGrowError] = useState<string | null>(null);
  const [growSuccess, setGrowSuccess] = useState(searchParams.get("grow") === "success");

  useEffect(() => {
    if (searchParams.get("grow") === "success") setGrowSuccess(true);
  }, [searchParams]);

  const growFee = growBudget * 0.2;
  const growTotal = growBudget + growFee;

  async function handleGrowCheckout() {
    setGrowLoading(true);
    setGrowError(null);
    try {
      const res = await fetch("/api/grow/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget: growBudget }),
      });
      const data = await res.json();
      if (!res.ok || !data.checkout_url) {
        setGrowError(data.error ?? "Something went wrong");
      } else {
        window.location.href = data.checkout_url;
      }
    } catch {
      setGrowError("Network error — please try again");
    } finally {
      setGrowLoading(false);
    }
  }

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data as { ok?: boolean } | undefined;

  if (actionData?.ok && !success) {
    setSuccess(true);
    setPromoteType(null);
    setPromoteLinkId("");
    setTargetAudience("");
    setBudget(null);
    setNotes("");
  }

  const canSubmit =
    !!promoteType &&
    (promoteType !== "link" || !!promoteLinkId) &&
    !!budget;

  function handleSubmit() {
    if (!canSubmit) return;
    setSuccess(false);
    const fd = new FormData();
    fd.append("promote_type", promoteType!);
    fd.append("promote_link_id", promoteLinkId);
    fd.append("target_audience", targetAudience);
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

      {/* ── SQRZ Grow section (grow_qualified only) ──────────────────────────── */}
      {grow_qualified && (
        <>
          <div style={{
            ...card,
            background: "linear-gradient(135deg, rgba(245,166,35,0.07) 0%, var(--surface) 100%)",
            border: "1.5px solid rgba(245,166,35,0.5)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <h2 style={{ ...sectionTitle, margin: 0 }}>SQRZ Grow</h2>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase" as const,
                background: "rgba(245,166,35,0.15)",
                color: ACCENT,
                padding: "3px 9px",
                borderRadius: 20,
                border: "1px solid rgba(245,166,35,0.3)",
              }}>
                Concierge
              </span>
            </div>
            <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 20px", lineHeight: 1.6 }}>
              Concierge campaign management — we handle everything.
            </p>

            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 24px", display: "flex", flexDirection: "column" as const, gap: 10 }}>
              {[
                "You set the budget — minimum $1,000",
                "SQRZ adds a 20% management fee for full campaign handling",
                "After payment, Will personally contacts you to define your strategy — Google, Meta, LinkedIn, TikTok, Spotify Ads or a mix — based on your goals and audience",
              ].map((point) => (
                <li key={point} style={{ display: "flex", gap: 10, fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}>
                  <span style={{ color: ACCENT, fontWeight: 700, flexShrink: 0 }}>•</span>
                  {point}
                </li>
              ))}
            </ul>

            {growSuccess ? (
              <div style={{
                background: "rgba(34,197,94,0.1)",
                border: "1px solid rgba(34,197,94,0.3)",
                borderRadius: 10,
                padding: "16px 18px",
                fontSize: 14,
                color: "#22c55e",
                lineHeight: 1.6,
              }}>
                Payment received! Will be in touch within 24 hours to schedule your strategy session.
              </div>
            ) : (
              <>
                {/* Budget input */}
                <div style={{ marginBottom: 20 }}>
                  <label style={labelStyle}>Campaign budget (USD)</label>
                  <input
                    type="number"
                    min={1000}
                    step={100}
                    value={growBudget}
                    onChange={(e) => setGrowBudget(Math.max(1000, Number(e.target.value)))}
                    style={{
                      width: "100%",
                      padding: "10px 13px",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      fontSize: 15,
                      color: "var(--text)",
                      outline: "none",
                      boxSizing: "border-box" as const,
                      fontFamily: FONT_BODY,
                    }}
                  />
                </div>

                {/* Fee breakdown */}
                <div style={{
                  background: "var(--bg)",
                  borderRadius: 10,
                  padding: "14px 16px",
                  marginBottom: 20,
                  fontSize: 13,
                  fontFamily: "monospace",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", marginBottom: 6 }}>
                    <span>Campaign budget</span>
                    <span>${growBudget.toLocaleString()}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", marginBottom: 10 }}>
                    <span>Management fee 20%</span>
                    <span>+${growFee.toLocaleString()}</span>
                  </div>
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", justifyContent: "space-between", fontWeight: 700, color: "var(--text)", fontSize: 14 }}>
                    <span>Total charged</span>
                    <span>${growTotal.toLocaleString()}</span>
                  </div>
                </div>

                {growError && (
                  <p style={{ fontSize: 13, color: "#f87171", marginBottom: 12 }}>{growError}</p>
                )}

                <button
                  type="button"
                  onClick={handleGrowCheckout}
                  disabled={growLoading}
                  style={{
                    width: "100%",
                    padding: "14px",
                    background: growLoading ? "var(--surface-muted)" : ACCENT,
                    color: growLoading ? "var(--text-muted)" : "#111",
                    border: "none",
                    borderRadius: 12,
                    fontSize: 15,
                    fontWeight: 700,
                    cursor: growLoading ? "not-allowed" : "pointer",
                    fontFamily: FONT_BODY,
                    letterSpacing: "0.02em",
                    transition: "background 0.15s",
                  }}
                >
                  {growLoading ? "Preparing checkout…" : "Proceed to Payment →"}
                </button>
              </>
            )}
          </div>

          {/* Separator */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "4px 0 24px" }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase" as const }}>
              Self-serve boost
            </span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>
        </>
      )}

      {locked && <UpgradeBanner planName="Boost plan" upgradeParam="boost" />}

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
            <button type="button" onClick={() => setPromoteType("profile")} style={pillStyle(promoteType === "profile")}>
              My Profile
            </button>
            <button type="button" onClick={() => setPromoteType("link")} style={pillStyle(promoteType === "link")}>
              A Private Link
            </button>
          </div>

          {promoteType === "link" && (
            <select
              value={promoteLinkId}
              onChange={(e) => setPromoteLinkId(e.target.value)}
              style={{
                marginTop: 10,
                width: "100%",
                padding: "10px 13px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 14,
                color: promoteLinkId ? "var(--text)" : "var(--text-muted)",
                outline: "none",
                boxSizing: "border-box" as const,
                fontFamily: FONT_BODY,
                cursor: "pointer",
              }}
            >
              <option value="">Select a link…</option>
              {privateLinks.map((link) => (
                <option key={link.id} value={link.id}>
                  {link.label || link.link_slug}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Target audience */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Who is your target audience?</label>
          <textarea
            rows={3}
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
            placeholder="e.g. Club promoters in Berlin, Festival organizers in France, Corporate event planners in NYC"
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
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
            Describe your ideal client in plain language — we handle the targeting.
          </p>
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
            placeholder="Anything specific you want us to know about this campaign?"
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
          disabled={isSubmitting || !canSubmit}
          style={{
            width: "100%",
            padding: "14px",
            background: !canSubmit ? "var(--surface-muted)" : ACCENT,
            color: !canSubmit ? "var(--text-muted)" : "#111",
            border: "none",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 700,
            cursor: !canSubmit ? "not-allowed" : "pointer",
            fontFamily: FONT_BODY,
            letterSpacing: "0.02em",
            transition: "background 0.15s",
          }}
        >
          {isSubmitting ? "Activating…" : "Activate Boost →"}
        </button>
      </div>

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
              const isPending = c.status === "draft" || c.status === "pending";
              const isPaid = c.status === "live" || c.status === "preparing";
              const baseUrl = BOOST_PAYMENT_LINKS[c.budget_amount] ?? null;
              const paymentUrl = baseUrl ? `${baseUrl}?client_reference_id=${c.id}&prefilled_email=${encodeURIComponent(email)}` : null;
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
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" as const }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                        {c.promote_type === "link" ? "Private Link" : "Profile"} Boost
                      </div>
                      {c.target_audience && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                          {c.target_audience}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                        ${c.budget_amount} {c.budget_currency}
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
    </div>
  );
}
