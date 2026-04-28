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

const textareaStyle: React.CSSProperties = {
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
};

type PrivateLink = {
  id: string;
  label: string | null;
  link_slug: string;
  page_type: string;
};

type Campaign = {
  id: string;
  created_at: string;
  profile_id: string;
  promote_type: string;
  promote_link_id: string | null;
  promote_service_id: string | null;
  goal: string | null;
  budget_amount: number;
  budget_currency: string;
  notes: string | null;
  status: "draft" | "pending" | "pending_payment" | "preparing" | "live" | "completed";
  channel: string | null;
  duration: string | null;
  utm_url: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  starts_at: string | null;
  ends_at: string | null;
  target_audience: string | null;
  campaign_type: string | null;
  fee_pct: number | null;
  fee_amount: number | null;
  stripe_payment_id: string | null;
  stripe_payment_status: string | null;
  stripe_payment_link_url: string | null;
  requires_payment: boolean | null;
  payment_expires_at: string | null;
  data_source: "live" | "manual" | null;
  live_profile_visits: number | null;
  live_unique_visitors: number | null;
  live_visits_last_7_days: number | null;
  live_engaged: number | null;
  live_service_clicks: number | null;
  live_booking_modal_opens: number | null;
  live_chat_opens: number | null;
  live_download_clicks: number | null;
  campaign_days_elapsed: number | null;
  campaign_duration_days: number | null;
  campaign_days_remaining: number | null;
};

const BUDGET_OPTIONS = [
  { value: 50, label: "$50" },
  { value: 100, label: "$100" },
  { value: 150, label: "$150" },
] as const;

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  draft:           { label: "Draft",           color: "#888",    bg: "rgba(136,136,136,0.12)" },
  pending:         { label: "Pending Payment", color: "#888",    bg: "rgba(136,136,136,0.12)" },
  pending_payment: { label: "Payment Due",     color: ACCENT,    bg: "rgba(245,166,35,0.15)"  },
  preparing:       { label: "Preparing",       color: ACCENT,    bg: "rgba(245,166,35,0.12)"  },
  live:            { label: "Live",            color: "#22c55e", bg: "rgba(34,197,94,0.12)"   },
  completed:       { label: "Completed",       color: "#888",    bg: "rgba(136,136,136,0.12)" },
};

const BOOST_PAYMENT_LINKS: Record<number, string> = {
  50:  "https://buy.stripe.com/7sY7sKbc35tI1gyanq57W01",
  100: "https://buy.stripe.com/bJeaEWgwn2hwe3k0MQ57W02",
  150: "https://buy.stripe.com/7sY9AScg7f4i8J0cvy57W03",
};

const GROW_MEETING_URL =
  "https://meetings.hubspot.com/willvilla/sqrz-grow-discovery-call?uuid=59eefc62-6d81-476a-9c7e-2aa4167f927b";

const DURATION_DAYS: Record<string, number> = {
  "1 Week":  7,
  "2 Weeks": 14,
  "1 Month": 30,
};

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const [{ data: campaigns }, { data: privateLinks }, { count: campaignCount }] = await Promise.all([
    supabase
      .from("boost_campaign_stats")
      .select(`
        id, created_at, profile_id, promote_type, promote_link_id,
        promote_service_id, goal, budget_amount, budget_currency,
        notes, status, channel, duration, utm_url, utm_source,
        utm_medium, utm_campaign, utm_content, starts_at, ends_at,
        target_audience, campaign_type, fee_pct, fee_amount,
        stripe_payment_id, stripe_payment_status,
        stripe_payment_link_url,
        requires_payment, payment_expires_at,
        live_profile_visits, live_unique_visitors,
        live_visits_last_7_days, live_engaged,
        live_service_clicks, live_booking_modal_opens,
        live_chat_opens, live_download_clicks,
        campaign_days_elapsed, campaign_duration_days,
        campaign_days_remaining, data_source
      `)
      .eq("profile_id", profile.id as string)
      .order("created_at", { ascending: false }),
    supabase
      .from("private_booking_links")
      .select("id, label, link_slug, page_type")
      .eq("profile_id", profile.id as string)
      .eq("is_active", true),
    supabase
      .from("boost_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profile.id as string),
  ]);

  return Response.json(
    {
      plan_id: (profile.plan_id as number | null) ?? null,
      is_beta: (profile.is_beta as boolean) ?? false,
      grow_qualified: (profile.grow_qualified as boolean) ?? false,
      campaign_count: campaignCount ?? 0,
      campaigns: campaigns ?? [],
      privateLinks: privateLinks ?? [],
      email: (profile.email as string) ?? "",
      profile_id: profile.id as string,
      profile_slug: (profile.slug as string) ?? "",
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
  const duration = (formData.get("duration") as string) || null;
  const newBudget = parseFloat(formData.get("budget_amount") as string);

  // ── Monthly cap check ($150/month for standard Boost) ──────────────────────
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data: monthlyBoosts } = await supabase
    .from("boost_campaigns")
    .select("budget_amount")
    .eq("profile_id", profile.id as string)
    .neq("promote_type", "grow")
    .neq("status", "cancelled")
    .gte("created_at", monthStart);

  const monthlyTotal = (monthlyBoosts ?? []).reduce((sum, c) => sum + (c.budget_amount ?? 0), 0);

  if (monthlyTotal + newBudget > 150) {
    return Response.json({
      ok: false,
      limitError: true,
      message: "You've reached your $150 monthly Boost limit.",
    }, { headers });
  }

  // ── Insert ─────────────────────────────────────────────────────────────────
  const { data: inserted, error } = await supabase
    .from("boost_campaigns")
    .insert({
      profile_id: profile.id as string,
      promote_type: promoteType,
      promote_link_id: promoteType === "link" && promoteLinkId ? promoteLinkId : null,
      channel: (formData.get("channel") as string) || null,
      duration,
      goal: (formData.get("goal") as string) || null,
      target_audience: (formData.get("target_audience") as string) || null,
      budget_amount: newBudget,
      budget_currency: "USD",
      notes: (formData.get("notes") as string) || null,
      status: "pending",
    })
    .select("id, utm_source, utm_campaign, utm_content")
    .single();

  if (error || !inserted) {
    return Response.json({ ok: false, error: error?.message }, { headers });
  }

  // ── Wire UTM URL + dates ───────────────────────────────────────────────────
  const today = new Date();
  const days = duration ? (DURATION_DAYS[duration] ?? 30) : 30;
  const endsAt = addDays(today, days);

  // Build base URL — always subdomain-based
  let baseUrl = `https://${profile.slug as string}.sqrz.com`;
  if (promoteType === "link" && promoteLinkId) {
    const { data: linkRow } = await supabase
      .from("private_booking_links")
      .select("link_slug")
      .eq("id", promoteLinkId)
      .single();
    if (linkRow?.link_slug) {
      baseUrl = `https://${profile.slug as string}.sqrz.com/${linkRow.link_slug}`;
    }
  }

  // Build UTM URL from trigger-populated fields
  let utmUrl: string | null = null;
  if (inserted.utm_source) {
    const params = new URLSearchParams({
      utm_source: inserted.utm_source,
      utm_medium: "paid",
      ...(inserted.utm_campaign ? { utm_campaign: inserted.utm_campaign } : {}),
      ...(inserted.utm_content ? { utm_content: inserted.utm_content } : {}),
    });
    utmUrl = `${baseUrl}?${params.toString()}`;
  }

  await supabase
    .from("boost_campaigns")
    .update({
      starts_at: toDateString(today),
      ends_at: toDateString(endsAt),
      ...(utmUrl ? { utm_url: utmUrl } : {}),
    })
    .eq("id", inserted.id);

  return Response.json({ ok: true, campaignId: inserted.id }, { headers });
}

export default function BoostPage() {
  const { campaigns, privateLinks, plan_id, is_beta, grow_qualified, campaign_count, email, profile_slug } =
    useLoaderData<typeof loader>() as {
      campaigns: Campaign[];
      privateLinks: PrivateLink[];
      plan_id: number | null;
      is_beta: boolean;
      grow_qualified: boolean;
      campaign_count: number;
      email: string;
      profile_id: string;
      profile_slug: string;
    };
  const isFirstCampaign = campaign_count === 0;
  const fetcher = useFetcher();
  const [searchParams] = useSearchParams();
  const locked = getPlanLevel(plan_id, is_beta) < FEATURE_GATES.boost;

  // Shared form state
  const [promoteType, setPromoteType] = useState<string | null>(null);
  const [promoteLinkId, setPromoteLinkId] = useState<string>("");
  const [targetAudience, setTargetAudience] = useState("");
  const [notes, setNotes] = useState("");

  // Boost-only state
  const [channel, setChannel] = useState<string | null>(null);
  const [duration, setDuration] = useState<string | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [boostSuccess, setBoostSuccess] = useState(false);
  const [boostError, setBoostError] = useState<string | null>(null);

  // Stats expand state — keyed by campaign id
  const [openStats, setOpenStats] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Grow-only state
  const growMinBudget = plan_id === null || plan_id === 4 ? 100 : 500;
  const [growBudget, setGrowBudget] = useState<string | number>("");
  const [growLoading, setGrowLoading] = useState(false);
  const [growError, setGrowError] = useState<string | null>(null);
  const [growSuccess, setGrowSuccess] = useState(searchParams.get("grow") === "success");

  useEffect(() => {
    if (searchParams.get("grow") === "success") setGrowSuccess(true);
  }, [searchParams]);

  const growBudgetNum = Number(growBudget);
  const growFee = Math.round(growBudgetNum * 0.2 * 100) / 100;
  const growTotal = growBudgetNum + growFee;

  const [retryingId, setRetryingId] = useState<string | null>(null);

  async function handleGrowRetry(budget: number, campaignId: string) {
    setRetryingId(campaignId);
    try {
      const res = await fetch("/api/grow/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget, campaignId }),
      });
      const data = await res.json();
      if (res.ok && data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    } catch { /* silent */ } finally {
      setRetryingId(null);
    }
  }

  async function handleGrowCheckout() {
    setGrowLoading(true);
    setGrowError(null);
    try {
      const res = await fetch("/api/grow/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          budget: growBudgetNum,
          promote_type: promoteType,
          promote_link_id: promoteType === "link" ? promoteLinkId : null,
          target_audience: targetAudience || null,
          notes: notes || null,
        }),
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
  const actionData = fetcher.data as { ok?: boolean; limitError?: boolean; message?: string; error?: string; campaignId?: string } | undefined;

  if (actionData?.ok && !boostSuccess) {
    setBoostSuccess(true);
    const paymentUrl = BOOST_PAYMENT_LINKS[Number(budget)];
    if (paymentUrl && actionData.campaignId) {
      const finalUrl = `${paymentUrl}?client_reference_id=${actionData.campaignId}&prefilled_email=${encodeURIComponent(email)}`;
      window.location.href = finalUrl;
    }
    setPromoteType(null);
    setPromoteLinkId("");
    setChannel(null);
    setDuration(null);
    setGoal(null);
    setTargetAudience("");
    setBudget(null);
    setNotes("");
  }

  const boostCanSubmit =
    !!promoteType &&
    (promoteType !== "link" || !!promoteLinkId) &&
    !!channel &&
    !!duration &&
    !!goal &&
    !!budget;

  const growCanSubmit =
    !!promoteType &&
    (promoteType !== "link" || !!promoteLinkId) &&
    growBudgetNum >= growMinBudget;

  function handleBoostSubmit() {
    if (!boostCanSubmit) {
      if (!promoteType) setBoostError("Please select what to promote.");
      else if (promoteType === "link" && !promoteLinkId) setBoostError("Please select a link.");
      else if (!channel) setBoostError("Please select a channel.");
      else if (!duration) setBoostError("Please select a duration.");
      else if (!goal) setBoostError("Please select a goal.");
      else if (!budget) setBoostError("Please select a budget.");
      return;
    }
    setBoostError(null);
    setBoostSuccess(false);
    const fd = new FormData();
    fd.append("promote_type", promoteType!);
    fd.append("promote_link_id", promoteLinkId);
    fd.append("channel", channel!);
    fd.append("duration", duration!);
    fd.append("goal", goal!);
    fd.append("target_audience", targetAudience);
    fd.append("budget_amount", String(budget));
    fd.append("notes", notes);
    fetcher.submit(fd, { method: "post" });
  }

  function toggleStats(id: string) {
    setOpenStats((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function copyToClipboard(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
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

  // ── Shared form fields ────────────────────────────────────────────────────
  const promoteField = (
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
  );

  const audienceField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>Who is your target audience?</label>
      <textarea
        rows={3}
        value={targetAudience}
        onChange={(e) => setTargetAudience(e.target.value)}
        placeholder="e.g. Club promoters in Berlin, Festival organizers in France, Corporate event planners in NYC"
        style={textareaStyle}
      />
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
        Describe your ideal client in plain language — we handle the targeting.
      </p>
    </div>
  );

  const notesField = (
    <div style={{ marginBottom: 24 }}>
      <label style={labelStyle}>Notes (optional)</label>
      <textarea
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Add a call to action, describe your style, mention specific dates, or anything else that helps us run a better campaign for you."
        style={textareaStyle}
      />
    </div>
  );

  // ── Boost-only form fields ─────────────────────────────────────────────────
  const channelField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>Where do you want to be seen?</label>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
        {["Meta (Facebook + Instagram)", "Google", "LinkedIn", "TikTok"].map((ch) => (
          <button key={ch} type="button" onClick={() => setChannel(ch)} style={pillStyle(channel === ch)}>
            {ch}
          </button>
        ))}
      </div>
    </div>
  );

  const durationField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>Campaign Duration</label>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
        {["1 Week", "2 Weeks", "1 Month"].map((d) => (
          <button key={d} type="button" onClick={() => setDuration(d)} style={pillStyle(duration === d)}>
            {d}
          </button>
        ))}
      </div>
    </div>
  );

  const goalField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>What's your goal?</label>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
        {[
          { label: "Get Bookings", value: "bookings" },
          { label: "Get Visibility", value: "visibility" },
          { label: "Grow Audience", value: "audience" },
        ].map((g) => (
          <button key={g.value} type="button" onClick={() => setGoal(g.value)} style={pillStyle(goal === g.value)}>
            {g.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>{grow_qualified ? "SQRZ Grow" : "Boost"}</h1>
      <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: -12, marginBottom: 28 }}>
        {grow_qualified
          ? "Concierge campaign management — we handle everything."
          : "Activate targeted attention for your profile"}
      </p>

      {/* ── GROW section ─────────────────────────────────────────────────────── */}
      {grow_qualified ? (
        <>
          <div style={{ ...card, background: "var(--surface)", border: "1px solid var(--border)" }}>
            {growSuccess ? (
              <div style={{
                background: "rgba(34,197,94,0.08)",
                border: "1px solid rgba(34,197,94,0.25)",
                borderRadius: 10,
                padding: "16px 18px",
                fontSize: 14,
                color: "var(--text)",
                lineHeight: 1.6,
              }}>
                Payment received! Will be in touch within 24 hours to schedule your strategy session.
              </div>
            ) : (
              <>
                {promoteField}
                {audienceField}

                <div style={{ marginBottom: 20 }}>
                  <label style={labelStyle}>Campaign budget (USD)</label>
                  <input
                    type="number"
                    min={growMinBudget}
                    value={growBudget}
                    onChange={(e) => setGrowBudget(e.target.value)}
                    placeholder={`e.g. ${growMinBudget}`}
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
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
                    Minimum ${growMinBudget.toLocaleString()} — this is your ad spend, separate from the management fee.
                  </p>
                </div>

                {growBudgetNum >= growMinBudget && (
                  <div style={{
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: "14px 16px",
                    marginBottom: 20,
                    fontSize: 13,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", marginBottom: 6 }}>
                      <span>Campaign budget</span>
                      <span style={{ fontFamily: "monospace" }}>${growBudgetNum.toLocaleString()}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", marginBottom: 10 }}>
                      <span>Management fee (20%)</span>
                      <span style={{ fontFamily: "monospace" }}>+${growFee.toLocaleString()}</span>
                    </div>
                    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", justifyContent: "space-between", fontWeight: 600, color: "var(--text)", fontSize: 14 }}>
                      <span>Total charged</span>
                      <span style={{ fontFamily: "monospace" }}>${growTotal.toLocaleString()}</span>
                    </div>
                  </div>
                )}

                {notesField}

                <ul style={{ listStyle: "none", padding: 0, margin: "0 0 20px", display: "flex", flexDirection: "column" as const, gap: 8 }}>
                  {[
                    `You set the budget — minimum $${growMinBudget.toLocaleString()} (your ad spend)`,
                    "SQRZ adds a 20% management fee for full campaign handling",
                    "After payment, book a strategy call to align on your channel mix — Google, Meta, LinkedIn, TikTok, Spotify Ads or a combination — based on your goals and audience.",
                  ].map((point) => (
                    <li key={point} style={{ display: "flex", gap: 10, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                      <span style={{ color: ACCENT, fontWeight: 700, flexShrink: 0 }}>•</span>
                      {point}
                    </li>
                  ))}
                </ul>

                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.6 }}>
                  {isFirstCampaign
                    ? "We recommend a quick call before your first campaign to make sure your budget works as hard as possible."
                    : "Strategy unchanged? Skip the call and top up directly."}
                </p>

                {growError && (
                  <p style={{ fontSize: 13, color: "#ef4444", marginBottom: 12 }}>{growError}</p>
                )}

                <div style={{ display: "flex", gap: 10 }}>
                  <a
                    href={GROW_MEETING_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      flex: 1,
                      padding: "13px",
                      background: "transparent",
                      color: "var(--text)",
                      border: "0.5px solid var(--border)",
                      borderRadius: 12,
                      fontSize: 14,
                      fontWeight: 500,
                      textAlign: "center" as const,
                      textDecoration: "none",
                      fontFamily: FONT_BODY,
                      boxSizing: "border-box" as const,
                    }}
                  >
                    Book a Call
                  </a>
                  <button
                    type="button"
                    onClick={handleGrowCheckout}
                    disabled={growLoading || !growCanSubmit}
                    style={{
                      flex: 1,
                      padding: "13px",
                      background: growLoading || !growCanSubmit ? "var(--surface-muted)" : ACCENT,
                      color: growLoading || !growCanSubmit ? "var(--text-muted)" : "#fff",
                      border: "none",
                      borderRadius: 12,
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: growLoading || !growCanSubmit ? "not-allowed" : "pointer",
                      fontFamily: FONT_BODY,
                      transition: "background 0.15s",
                    }}
                  >
                    {growLoading ? "Preparing…" : "Proceed to Payment →"}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      ) : (
        /* ── BOOST section ───────────────────────────────────────────────────── */
        <>
          {locked && <UpgradeBanner planName="Boost plan" upgradeParam="boost" />}

          <div style={{ ...card, ...(locked ? { opacity: 0.45, pointerEvents: "none" } : {}) }}>
            <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 14px" }}>
              New Boost Campaign
            </h2>

            {/* How Boost works */}
            <div style={{
              background: "rgba(245,166,35,0.06)",
              border: "1px solid rgba(245,166,35,0.18)",
              borderRadius: 10,
              padding: "12px 14px",
              marginBottom: 24,
              fontSize: 13,
              color: "var(--text-muted)",
              lineHeight: 1.6,
            }}>
              Boost runs a single-channel paid ad campaign pointing to your SQRZ profile or link. You choose the channel and budget — we handle setup and execution. Ad spend is separate from your $39/mo subscription.
            </div>

            {boostSuccess && (
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
                Campaign created — complete payment below to activate it.
              </div>
            )}

            <div style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
              color: "var(--text-muted)",
              marginBottom: 16,
            }}>
              💡 <strong>Tip:</strong> Add your Meta or Google pixel in Profile → Settings to retarget visitors from this campaign. SQRZ tracks all visits automatically — your pixel handles the retargeting on your own ad account.
            </div>

            {promoteField}
            {channelField}
            {durationField}
            {goalField}
            {audienceField}

            {/* Budget pills */}
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

            {notesField}

            {actionData?.ok === false && !actionData?.limitError && (
              <p style={{ fontSize: 13, color: "#ef4444", marginBottom: 12 }}>
                {actionData.error ?? "Something went wrong. Please try again."}
              </p>
            )}

            {actionData?.limitError && (
              <p style={{ fontSize: 13, color: "#ef4444", marginBottom: 12 }}>
                Monthly boost limit reached ($150/mo). Upgrade to Grow for unlimited campaigns.
              </p>
            )}

            <button
              type="button"
              onClick={handleBoostSubmit}
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "14px",
                background: ACCENT,
                color: "#111",
                border: "none",
                borderRadius: 12,
                fontSize: 15,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT_BODY,
                letterSpacing: "0.02em",
                transition: "background 0.15s",
                opacity: isSubmitting ? 0.7 : 1,
              }}
            >
              {isSubmitting ? "Activating…" : "Activate Boost →"}
            </button>

            {boostError && (
              <p style={{ fontSize: 13, color: "#ef4444", marginTop: 8, marginBottom: 0 }}>
                {boostError}
              </p>
            )}

            {/* Grow upsell */}
            <div style={{
              marginTop: 16,
              padding: "13px 16px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              fontSize: 13,
              color: "var(--text-muted)",
              lineHeight: 1.6,
            }}>
              Want a multichannel strategy with creative support? SQRZ Grow clients get a dedicated campaign plan and monthly strategy calls.{" "}
              <a
                href={GROW_MEETING_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: ACCENT, fontWeight: 600, textDecoration: "none" }}
              >
                Talk to Will →
              </a>
            </div>
          </div>
        </>
      )}

      {/* ── Active Campaigns ─────────────────────────────────────────────────── */}
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
              const isPending = c.status === "draft" || c.status === "pending" || c.status === "pending_payment";
              const isPaid = c.status === "live" || c.status === "preparing";
              const hasStats = c.status === "live" || c.status === "completed";
              const baseUrl = c.stripe_payment_link_url ?? BOOST_PAYMENT_LINKS[c.budget_amount] ?? null;
              const paymentUrl = baseUrl
                ? `${baseUrl}?client_reference_id=${c.id}&prefilled_email=${encodeURIComponent(email)}`
                : null;
              const isStatsOpen = !!openStats[c.id];

              const engagedParts = [
                (c.live_service_clicks ?? 0) > 0     ? `${c.live_service_clicks} service click${c.live_service_clicks !== 1 ? "s" : ""}` : null,
                (c.live_booking_modal_opens ?? 0) > 0 ? `${c.live_booking_modal_opens} modal open${c.live_booking_modal_opens !== 1 ? "s" : ""}` : null,
                (c.live_chat_opens ?? 0) > 0         ? `${c.live_chat_opens} chat${c.live_chat_opens !== 1 ? "s" : ""}` : null,
                (c.live_download_clicks ?? 0) > 0    ? `${c.live_download_clicks} download${c.live_download_clicks !== 1 ? "s" : ""}` : null,
              ].filter(Boolean);
              const engagedSublabel = engagedParts.length > 0 ? engagedParts.join(" · ") : "—";

              const STATS_ROWS = [
                { label: "Profile Visits",  value: c.live_profile_visits,    format: "int" },
                { label: "Unique Visitors", value: c.live_unique_visitors,    format: "int" },
                { label: "Last 7 Days",     value: c.live_visits_last_7_days, format: "int" },
                { label: "Engaged",         value: c.live_engaged ?? 0,       format: "int", sublabel: engagedSublabel },
              ];
              const allStatsEmpty = STATS_ROWS.every((r) => !r.value);

              return (
                <div
                  key={c.id}
                  style={{
                    background: "var(--bg)",
                    borderRadius: 12,
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column" as const,
                    gap: 0,
                  }}
                >
                  {/* Campaign header row */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" as const }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                        {c.promote_type === "grow" ? "Grow Campaign" : c.promote_type === "link" ? "Private Link Boost" : "Profile Boost"}
                      </div>
                      {c.channel && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                          {c.channel}{c.duration ? ` · ${c.duration}` : ""}
                        </div>
                      )}
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
                          Paid ✓
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
                      {isPending && (
                        paymentUrl ? (
                          <a
                            href={paymentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: "inline-block",
                              padding: "6px 14px",
                              background: ACCENT,
                              color: "#111",
                              borderRadius: 8,
                              fontSize: 12,
                              fontWeight: 700,
                              textDecoration: "none",
                              whiteSpace: "nowrap" as const,
                            }}
                          >
                            Proceed to Payment →
                          </a>
                        ) : (
                          <button
                            onClick={() => handleGrowRetry(c.budget_amount, c.id)}
                            disabled={retryingId !== null}
                            style={{
                              display: "inline-block",
                              padding: "6px 14px",
                              background: ACCENT,
                              color: "#111",
                              border: "none",
                              borderRadius: 8,
                              fontSize: 12,
                              fontWeight: 700,
                              cursor: retryingId !== null ? "wait" : "pointer",
                              whiteSpace: "nowrap" as const,
                            }}
                          >
                            {retryingId !== null ? "Redirecting…" : "Complete Payment →"}
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {/* Payment section for pending campaigns */}
                  {isPending && !grow_qualified && (
                    <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 10 }}>
                        Ad Budget
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", marginBottom: 12 }}>
                        ${c.budget_amount}
                      </div>
                      {paymentUrl ? (
                        <a
                          href={paymentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: "block",
                            width: "100%",
                            padding: "12px",
                            background: ACCENT,
                            color: "#111",
                            borderRadius: 10,
                            fontSize: 14,
                            fontWeight: 700,
                            textAlign: "center" as const,
                            textDecoration: "none",
                            cursor: "pointer",
                            fontFamily: FONT_BODY,
                            boxSizing: "border-box" as const,
                            marginBottom: 8,
                          }}
                        >
                          Pay ${c.budget_amount} →
                        </a>
                      ) : (
                        <div style={{
                          padding: "12px",
                          background: "var(--surface-muted)",
                          borderRadius: 10,
                          fontSize: 13,
                          color: "#ef4444",
                          textAlign: "center" as const,
                          marginBottom: 8,
                        }}>
                          Payment link unavailable — contact support
                        </div>
                      )}
                      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
                        Ad budget is separate from your SQRZ subscription. It goes directly toward running your campaigns.
                      </p>
                    </div>
                  )}

                  {/* View Stats toggle */}
                  <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 10 }}>
                    <button
                      type="button"
                      onClick={() => toggleStats(c.id)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        fontFamily: FONT_BODY,
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      <span style={{ fontSize: 10, display: "inline-block", transform: isStatsOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>
                      {isStatsOpen ? "Hide Stats" : "View Stats"}
                    </button>

                    {isStatsOpen && (
                      <div style={{ marginTop: 14 }}>
                        {!hasStats ? (
                          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>
                            Your campaign stats will appear here once it goes live.
                          </p>
                        ) : allStatsEmpty ? (
                          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>
                            Your campaign stats will appear here once it goes live.
                          </p>
                        ) : (
                          <>
                            {/* Stats grid — 2 columns */}
                            <div style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr",
                              gap: 8,
                              marginBottom: 14,
                            }}>
                              {STATS_ROWS.map(({ label, value, format, sublabel }: { label: string; value: number | null; format: string; sublabel?: string }) => (
                                <div
                                  key={label}
                                  style={{
                                    background: "var(--surface)",
                                    border: "1px solid var(--border)",
                                    borderRadius: 10,
                                    padding: "10px 12px",
                                  }}
                                >
                                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 4 }}>
                                    {label}
                                  </div>
                                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", fontFamily: FONT_DISPLAY }}>
                                    {value == null
                                      ? "—"
                                      : format === "currency"
                                        ? `$${Number(value).toFixed(2)}`
                                        : Number(value).toLocaleString()}
                                  </div>
                                  {sublabel && (
                                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.3 }}>
                                      {sublabel}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>

                            {/* Funnel */}
                            {(c.live_profile_visits ?? 0) > 0 && c.data_source === "live" && (
                              <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", gap: 8, alignItems: "center", marginTop: 8, marginBottom: 10, flexWrap: "wrap" as const }}>
                                <span>{c.live_profile_visits} visited</span>
                                <span>→</span>
                                <span>{c.live_engaged ?? 0} engaged</span>
                                {(c.live_booking_modal_opens ?? 0) > 0 && (
                                  <>
                                    <span>→</span>
                                    <span>{c.live_booking_modal_opens} considered booking</span>
                                  </>
                                )}
                              </div>
                            )}

                            {/* Campaign progress */}
                            {c.campaign_days_elapsed != null && c.campaign_duration_days != null && (
                              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
                                {(c.campaign_days_remaining ?? 0) === 0
                                  ? "Campaign ended"
                                  : `Day ${c.campaign_days_elapsed} of ${c.campaign_duration_days}`}
                              </p>
                            )}


                          </>
                        )}

                        {/* Campaign destination */}
                        {(() => {
                          let destination: string;
                          if (c.promote_type === "link" && c.promote_link_id) {
                            const pl = privateLinks.find((l) => l.id === c.promote_link_id);
                            destination = pl
                              ? `${profile_slug}.sqrz.com/${pl.link_slug}`
                              : `${profile_slug}.sqrz.com`;
                          } else if (c.utm_url) {
                            destination = c.utm_url.split("?")[0].replace(/^https?:\/\//, "");
                          } else {
                            destination = `${profile_slug}.sqrz.com`;
                          }
                          return (
                            <div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 4 }}>
                                Campaign Destination
                              </div>
                              <div style={{ fontSize: 13, color: "var(--text)" }}>
                                {destination}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
