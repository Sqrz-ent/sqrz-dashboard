import { useState } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.office.partners";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";
const ACCENT_BG = "rgba(245,166,35,0.12)";
const AMBER = "#fbbf24";
const GREEN = "#4ade80";
const BLUE = "#185FA5";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 12,
};

const lbl: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 4px",
  display: "block",
};

// ─── Types ────────────────────────────────────────────────────────────────────

type ReferralStatus = "active" | "expired" | "pending";
type TabKey = "active" | "booked" | "expired" | "pending";

type Referral = {
  slug: string;
  planLabel: string;
  earned: number;
  status: ReferralStatus;
  hasStripeConnect: boolean;
};

type BookingRow = {
  referred_slug: string;
  commission_amount: number;
};

type LoaderData = {
  refCode: string | null;
  commissionPct: number;
  tier: "Starter" | "Pro" | "Elite";
  referrals: Referral[];
  stats: { all: number; active: number; expired: number; pending: number };
  earnings: { lifetime: number; pending: number; paid: number; pendingSubTotal: number; pendingBookingTotal: number };
  activeCount: number;
  nextTierCount: number | null;
  bookingTotal: number;
  bookingCount: number;
  bookingRows: BookingRow[];
  connectStatus: string;
  stripeExpressUrl: string | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function planLabel(planId: number | null): string {
  if (!planId) return "—";
  const map: Record<number, string> = {
    1: "Creator",
    2: "Grow",
    3: "Grow Pro",
    4: "Early Access",
    5: "Boost",
  };
  return map[planId] ?? "Plan";
}

function tierFromPct(pct: number): "Starter" | "Pro" | "Elite" {
  if (pct >= 50) return "Elite";
  if (pct >= 40) return "Pro";
  return "Starter";
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-EU", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n);
}

function nextMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });
  if (!profile.is_partner) return redirect("/office", { headers });

  // Connect status
  const connectStatus = (profile.stripe_connect_status as string | null) ?? "not_connected";
  const connectId = (profile.stripe_connect_id as string | null) ?? null;

  let stripeExpressUrl: string | null = null;
  if (connectId && connectStatus === "active") {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    stripeExpressUrl = await stripe.accounts.createLoginLink(connectId).then((l) => l.url).catch(() => null);
  }

  // 1. Referral code
  const { data: refCodeRow } = await supabase
    .from("referral_codes")
    .select("id, code, commission_pct, tier_grace_until")
    .eq("owner_id", profile.id as string)
    .eq("is_active", true)
    .maybeSingle();

  const commissionPct: number = (refCodeRow?.commission_pct as number | null) ?? 30;
  const refCode: string | null = (refCodeRow?.code as string | null) ?? null;

  // 2. Referral uses (separate query, no join)
  const { data: rawUses } = refCodeRow
    ? await supabase
        .from("referral_uses")
        .select("id, referred_profile_id, converted, first_paid_at, commission_ends_at")
        .eq("referral_code_id", refCodeRow.id as string)
        .order("created_at", { ascending: false })
    : { data: [] };

  // 3. Referred profiles (separate query, merge in JS)
  const referredIds = (rawUses ?? []).map((r) => r.referred_profile_id as string);
  const { data: referredProfiles } = await supabase
    .from("profiles")
    .select("id, slug, plan_id, updated_at, stripe_connect_id, stripe_connect_status")
    .in("id", referredIds.length ? referredIds : ["00000000-0000-0000-0000-000000000000"]);

  // 4. Earnings
  const { data: rawEarnings } = await supabase
    .from("partner_earnings")
    .select("commission_amount, payout_status, referred_profile_id")
    .eq("partner_id", profile.id as string);

  // Build per-referred-profile earned map
  const earnedByProfile: Record<string, number> = {};
  const paidTotal = { pending: 0, paid: 0 };
  for (const e of rawEarnings ?? []) {
    const amt = Number(e.commission_amount ?? 0);
    const pid = e.referred_profile_id as string;
    earnedByProfile[pid] = (earnedByProfile[pid] ?? 0) + amt;
    if (e.payout_status === "paid") paidTotal.paid += amt;
    else paidTotal.pending += amt;
  }
  const lifetimeEarned = Object.values(earnedByProfile).reduce((s, v) => s + v, 0);
  const pendingSubTotal = paidTotal.pending;

  // Build referral rows (merge uses + profiles in JS)
  const referrals: Referral[] = (rawUses ?? []).map((u) => {
    const prof = (referredProfiles ?? []).find((p) => p.id === u.referred_profile_id);
    const slug = (prof?.slug as string | null) ?? "unknown";
    const plan = (prof?.plan_id as number | null) ?? null;
    const earned = earnedByProfile[(u.referred_profile_id as string)] ?? 0;
    const commissionEndsAt = u.commission_ends_at as string | null;
    const converted = !!(u.converted);

    // active: converted, commission window still open
    // expired: converted, commission window closed (or null)
    // pending: never converted
    const status: ReferralStatus = !converted
      ? "pending"
      : commissionEndsAt && new Date(commissionEndsAt) > new Date()
        ? "active"
        : "expired";

    const hasStripeConnect = !!(prof?.stripe_connect_id && prof?.stripe_connect_status === "active");
    return { slug, planLabel: planLabel(plan), earned, status, hasStripeConnect };
  });

  // Stats
  const stats = {
    all: referrals.length,
    active: referrals.filter((r) => r.status === "active").length,
    expired: referrals.filter((r) => r.status === "expired").length,
    pending: referrals.filter((r) => r.status === "pending").length,
  };

  const activeCount = stats.active;
  const tier = tierFromPct(commissionPct);
  const nextTierCount = tier === "Elite" ? null : tier === "Pro" ? 15 : 5;

  // 5. Booking referral earnings
  const { data: rawBookingEarnings } = await supabase
    .from("booking_referral_earnings")
    .select("commission_amount, payout_status, referred_id")
    .eq("referrer_id", profile.id as string);

  const bookingTotal = (rawBookingEarnings ?? []).reduce(
    (s, r) => s + Number(r.commission_amount ?? 0),
    0
  );
  const bookingCount = (rawBookingEarnings ?? []).length;
  const pendingBookingTotal = (rawBookingEarnings ?? [])
    .filter((r) => r.payout_status === "pending")
    .reduce((s, r) => s + Number(r.commission_amount ?? 0), 0);

  // Fetch referred profile slugs for booking rows
  const bookingReferredIds = [...new Set(
    (rawBookingEarnings ?? []).map((r) => r.referred_id as string).filter(Boolean)
  )];
  const { data: bookingProfiles } = bookingReferredIds.length
    ? await supabase
        .from("profiles")
        .select("id, slug")
        .in("id", bookingReferredIds)
    : { data: [] };

  const bookingSlugMap: Record<string, string> = {};
  for (const p of bookingProfiles ?? []) {
    bookingSlugMap[p.id as string] = (p.slug as string) ?? "unknown";
  }

  const bookingRows: BookingRow[] = (rawBookingEarnings ?? []).map((r) => ({
    referred_slug: bookingSlugMap[r.referred_id as string] ?? "unknown",
    commission_amount: Number(r.commission_amount ?? 0),
  }));

  return Response.json(
    {
      refCode,
      commissionPct,
      tier,
      referrals,
      stats,
      earnings: { lifetime: lifetimeEarned, pending: pendingSubTotal + pendingBookingTotal, paid: paidTotal.paid, pendingSubTotal, pendingBookingTotal },
      activeCount,
      nextTierCount,
      bookingTotal,
      bookingCount,
      bookingRows,
      connectStatus,
      stripeExpressUrl,
    } satisfies LoaderData,
    { headers }
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PartnersPage() {
  const {
    refCode,
    commissionPct,
    tier,
    referrals,
    stats,
    earnings,
    activeCount,
    nextTierCount,
    bookingTotal,
    bookingCount,
    bookingRows,
    connectStatus,
    stripeExpressUrl,
  } = useLoaderData<typeof loader>() as LoaderData;

  const connectFetcher = useFetcher();
  const isConnecting = connectFetcher.state !== "idle";
  const isPending = connectStatus === "pending";
  const isActive = connectStatus === "active";

  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<TabKey>("active");
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  function copyReferralLink(slug: string) {
    const url = `https://${slug}.sqrz.com?ref=${refCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug(null), 1500);
    });
  }

  const refUrl = refCode ? `https://sqrz.com?ref=${refCode}` : null;

  function copyLink() {
    if (!refUrl) return;
    navigator.clipboard.writeText(refUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const tierOrder: Array<"Starter" | "Pro" | "Elite"> = ["Starter", "Pro", "Elite"];
  const tierPcts: Record<string, number> = { Starter: 30, Pro: 40, Elite: 50 };
  const tierThresholds: Record<string, number | null> = { Starter: 5, Pro: 15, Elite: null };

  const progress = nextTierCount ? Math.min(1, activeCount / nextTierCount) : 1;

  const filteredReferrals = tab === "booked"
    ? []
    : referrals.filter((r) => r.status === (tab as ReferralStatus));

  const tableLabels: Record<TabKey, string> = {
    active: "Active referrals",
    booked: "Booking commissions",
    expired: "Expired",
    pending: "Pending",
  };

  const tabDefs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "active",  label: "Active",  count: stats.active  },
    { key: "booked",  label: "Booked",  count: bookingRows.length },
    { key: "expired", label: "Expired", count: stats.expired },
    { key: "pending", label: "Pending", count: stats.pending },
  ];

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 20px 100px", fontFamily: FONT_BODY, color: "var(--text)" }}>

      {/* ── Section 1: Header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", color: "var(--text)" }}>Partner program</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 2px" }}>
            You've been invited by Will Villa into the SQRZ Partner Program.
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, opacity: 0.7 }}>
            Earn {commissionPct}% of every subscription you bring in, for 12 months.
          </p>
          <p style={{ fontSize: 13, color: "var(--color-text-tertiary)", marginTop: 3 }}>
            To earn booking commissions, your referrals need to activate Stripe Connect on their profile.
          </p>
        </div>
        <span style={{
          padding: "4px 12px",
          borderRadius: 20,
          background: ACCENT_BG,
          color: ACCENT,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.04em",
          whiteSpace: "nowrap",
        }}>
          {tier} · {commissionPct}%
        </span>
      </div>

      {/* ── Section 2: Referral link ───────────────────────────────────────── */}
      {refUrl && (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>🔗</span>
          <span style={{ flex: 1, color: ACCENT, fontSize: 13, fontFamily: "monospace", wordBreak: "break-all" }}>
            {refUrl}
          </span>
          <button
            onClick={copyLink}
            style={{
              flexShrink: 0,
              padding: "7px 16px",
              borderRadius: 20,
              border: "none",
              background: copied ? "rgba(74,222,128,0.15)" : "var(--surface-muted)",
              color: copied ? GREEN : "var(--text)",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
      )}

      {/* ── Section: Client Payments (Connect) ─────────────────────────────── */}
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "16px 18px",
        marginBottom: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isActive || isPending ? 16 : 0 }}>
          <p style={{ ...lbl, margin: 0 }}>Client Payments</p>

          {isActive ? (
            stripeExpressUrl ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                <div style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "rgba(243,177,48,0.1)",
                  border: "1px solid rgba(243,177,48,0.3)",
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 11,
                  color: "#F3B130",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase" as const,
                }}>
                  ⚠ Test mode — real payouts not yet active
                </div>
                <a
                  href={stripeExpressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    padding: "7px 14px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    color: "var(--text)",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: FONT_BODY,
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                >
                  Manage Payouts →
                </a>
              </div>
            ) : (
              <span style={{
                padding: "7px 14px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 10,
                color: "var(--text)",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: FONT_BODY,
                opacity: 0.4,
              }}>
                Manage Payouts →
              </span>
            )
          ) : isPending ? (
            <connectFetcher.Form method="post" action="/api/stripe/connect?returnTo=partners">
              <button
                type="submit"
                disabled={isConnecting}
                style={{
                  padding: "7px 14px",
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  color: "var(--text)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: isConnecting ? "default" : "pointer",
                  fontFamily: FONT_BODY,
                  opacity: isConnecting ? 0.6 : 1,
                }}
              >
                {isConnecting ? "Redirecting…" : "Continue Setup →"}
              </button>
            </connectFetcher.Form>
          ) : null}
        </div>

        {!isActive && !isPending && (
          <div style={{ paddingTop: 14, borderTop: "1px solid var(--border)" }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px" }}>
              Connect your bank account to receive booking payments.
            </p>
            <connectFetcher.Form method="post" action="/api/stripe/connect?returnTo=partners">
              <button
                type="submit"
                disabled={isConnecting}
                style={{
                  padding: "10px 20px",
                  background: ACCENT,
                  border: "none",
                  borderRadius: 10,
                  color: "#111111",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: isConnecting ? "default" : "pointer",
                  fontFamily: FONT_BODY,
                  opacity: isConnecting ? 0.6 : 1,
                }}
              >
                {isConnecting ? "Redirecting…" : "Connect Bank Account →"}
              </button>
            </connectFetcher.Form>
          </div>
        )}

        {isPending && (
          <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Onboarding in progress — finish setting up your Stripe account to receive payouts.
            </p>
          </div>
        )}

        {isActive && (
          <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Your payout history is available in the{" "}
              {stripeExpressUrl ? (
                <a href={stripeExpressUrl} target="_blank" rel="noopener noreferrer" style={{ color: ACCENT, textDecoration: "none", fontWeight: 600 }}>
                  Stripe Express dashboard →
                </a>
              ) : (
                <span style={{ color: "var(--text-muted)" }}>Stripe Express dashboard</span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* ── Section 3: Earnings cards ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4" style={{ gap: 12, marginBottom: 20 }}>
        <div style={card}>
          <span style={lbl}>Lifetime earned</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "var(--text)" }}>{fmtMoney(earnings.lifetime)}</p>
        </div>
        <div style={{ ...card, borderColor: earnings.pending > 0 ? "rgba(251,191,36,0.3)" : "var(--border)" }}>
          <span style={lbl}>Pending payout</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: "0 0 2px", color: earnings.pending > 0 ? AMBER : "var(--text)" }}>
            {fmtMoney(earnings.pending)}
          </p>
          <div style={{ marginTop: 6, marginBottom: 6, display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
              <span>Subscriptions</span>
              <span>{fmtMoney(earnings.pendingSubTotal)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
              <span>Bookings</span>
              <span>{fmtMoney(earnings.pendingBookingTotal)}</span>
            </div>
          </div>
          {earnings.pending >= 25 ? (
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>Next batch {nextMonth()}</p>
          ) : (
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>€25 minimum</p>
          )}
        </div>
        <div style={{ ...card, borderColor: earnings.paid > 0 ? "rgba(74,222,128,0.3)" : "var(--border)" }}>
          <span style={lbl}>Subscriptions paid</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: "0 0 2px", color: earnings.paid > 0 ? GREEN : "var(--text)" }}>{fmtMoney(earnings.paid)}</p>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>from subscription commissions</p>
        </div>
        <div style={{ ...card, borderColor: bookingTotal > 0 ? "rgba(24,95,165,0.3)" : "var(--border)" }}>
          <span style={lbl}>Lifetime bookings</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: "0 0 2px", color: bookingTotal > 0 ? BLUE : "var(--text)" }}>
            {fmtMoney(bookingTotal)}
          </p>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
            from {bookingCount} completed booking{bookingCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {/* ── Section 4: Tier progress ─────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>
            {tier === "Elite"
              ? "Maximum tier reached"
              : tier === "Pro"
                ? `Pro tier reached — ${(nextTierCount ?? 0) - activeCount} more active referrals to Elite (50%)`
                : `${activeCount} of ${nextTierCount} active referrals to Pro (40%)`}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {tierOrder.map((t) => {
              const isCurrent = t === tier;
              const isNext = tierOrder.indexOf(t) === tierOrder.indexOf(tier) + 1;
              return (
                <span key={t} style={{
                  padding: "3px 10px",
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 700,
                  background: isCurrent ? ACCENT_BG : "transparent",
                  color: isCurrent ? ACCENT : isNext ? ACCENT : "var(--text-muted)",
                  border: isCurrent ? `1px solid ${ACCENT}` : isNext ? `1px solid rgba(245,166,35,0.4)` : "1px solid var(--border)",
                }}>
                  {t} {tierPcts[t]}%
                </span>
              );
            })}
          </div>
        </div>

        {tier !== "Elite" && (
          <>
            <div style={{ height: 6, borderRadius: 6, background: "var(--surface-muted)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progress * 100}%`, background: ACCENT, borderRadius: 6, transition: "width 0.4s ease" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{activeCount} active now</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {(tierThresholds[tier] ?? 0) - activeCount > 0
                  ? `${(tierThresholds[tier] ?? 0) - activeCount} more to ${tier === "Starter" ? "Pro" : "Elite"}`
                  : `Qualifying for ${tier === "Starter" ? "Pro" : "Elite"}`}
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Section 5: Tab cards ──────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
        {tabDefs.map(({ key, label, count }) => {
          const isSelected = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                background: "var(--surface)",
                border: isSelected ? `1.5px solid ${ACCENT}` : "1px solid var(--border)",
                borderRadius: 10,
                padding: "12px 14px",
                cursor: "pointer",
                textAlign: "left",
                color: "var(--text)",
                fontFamily: FONT_BODY,
              }}
            >
              <p style={{ fontSize: 18, fontWeight: 700, margin: "0 0 2px", color: isSelected ? ACCENT : "var(--text)" }}>{count}</p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</p>
            </button>
          );
        })}
      </div>

      {/* ── Section 6: Table ──────────────────────────────────────────────── */}
      <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {tableLabels[tab]}
      </p>
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
          <thead>
            <tr style={{ background: "var(--surface-muted)", borderBottom: "1px solid var(--border)" }}>
              {(
                [
                  { label: "Referral",      width: "26%" },
                  { label: "Type",          width: "24%" },
                  { label: "Your earnings", width: "26%" },
                  { label: "Status",        width: "24%" },
                ] as const
              ).map(({ label, width }) => (
                <th key={label} style={{ ...lbl, display: "table-cell", padding: "10px 14px", textAlign: "left", margin: 0, width }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tab === "booked" ? (
              bookingRows.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: "28px 14px", color: "var(--text-muted)", textAlign: "center" }}>
                    No booking commissions yet.
                  </td>
                </tr>
              ) : (
                bookingRows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "11px 14px", fontFamily: "monospace", color: "var(--text)", fontWeight: 600, overflow: "hidden" }}>
                      <span className="truncate block">{r.referred_slug}</span>
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      <span style={{
                        padding: "2px 8px",
                        borderRadius: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        background: "rgba(24,95,165,0.12)",
                        color: BLUE,
                      }}>
                        Booking
                      </span>
                    </td>
                    <td style={{ padding: "11px 14px", fontWeight: 700 }}>
                      {fmtMoney(r.commission_amount)}
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      <span style={{
                        padding: "2px 8px",
                        borderRadius: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        background: "rgba(24,95,165,0.12)",
                        color: BLUE,
                      }}>
                        Booked
                      </span>
                    </td>
                  </tr>
                ))
              )
            ) : (
              filteredReferrals.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: "28px 14px", color: "var(--text-muted)", textAlign: "center" }}>
                    No referrals yet. Share your link to get started.
                  </td>
                </tr>
              ) : (
                filteredReferrals.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "11px 14px", fontFamily: "monospace", color: "var(--text)", fontWeight: 600, overflow: "hidden" }}>
                      {r.status === "active" ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <span className="truncate" style={{ minWidth: 0, flex: "1 1 0" }}>{r.slug}</span>
                          {r.hasStripeConnect ? (
                            <button
                              className="hidden md:inline-flex items-center"
                              onClick={() => copyReferralLink(r.slug)}
                              title={`Copy referral link for ${r.slug}`}
                              style={{
                                background: "none",
                                border: "0.5px solid var(--border)",
                                borderRadius: 6,
                                padding: "2px 7px",
                                fontSize: 11,
                                color: "var(--text-muted)",
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                                fontFamily: FONT_BODY,
                                flexShrink: 0,
                              }}
                            >
                              {copiedSlug === r.slug ? "copied!" : "copy link"}
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="truncate block">{r.slug}</span>
                      )}
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      {r.status === "pending" ? (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      ) : (
                        <span style={{
                          padding: "2px 8px",
                          borderRadius: 20,
                          fontSize: 11,
                          fontWeight: 700,
                          background: r.planLabel.includes("Boost") ? "rgba(251,191,36,0.12)" : "rgba(96,165,250,0.12)",
                          color: r.planLabel.includes("Boost") ? AMBER : "#60a5fa",
                        }}>
                          {r.planLabel}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      {r.status === "pending" ? (
                        <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>not subscribed</span>
                      ) : (
                        <span style={{ fontWeight: r.earned > 0 ? 700 : 400, color: r.earned > 0 ? "var(--text)" : "var(--text-muted)" }}>
                          {fmtMoney(r.earned)}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <StatusPill status={r.status} />
                        {r.status === "active" && r.hasStripeConnect && (
                          <button
                            className="md:hidden"
                            onClick={() => copyReferralLink(r.slug)}
                            title={`Copy referral link for ${r.slug}`}
                            style={{
                              background: copiedSlug === r.slug ? "rgba(74,222,128,0.15)" : "none",
                              border: "0.5px solid var(--border)",
                              borderRadius: 6,
                              padding: "3px 5px",
                              cursor: "pointer",
                              color: copiedSlug === r.slug ? GREEN : "var(--text-muted)",
                              display: "flex",
                              alignItems: "center",
                              flexShrink: 0,
                              transition: "all 0.15s",
                            }}
                          >
                            {copiedSlug === r.slug ? (
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <path d="M3 8l3.5 3.5L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            ) : (
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <rect x="5" y="2" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                                <path d="M5 4H3.5A1.5 1.5 0 0 0 2 5.5v8A1.5 1.5 0 0 0 3.5 15h6A1.5 1.5 0 0 0 11 13.5V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ReferralStatus }) {
  const map: Record<ReferralStatus, { label: string; bg: string; color: string }> = {
    active:  { label: "Active",  bg: "#E1F5EE", color: "#0F6E56" },
    expired: { label: "Expired", bg: "var(--surface-muted)", color: "var(--text-muted)" },
    pending: { label: "Pending", bg: "#FAEEDA", color: "#854F0B" },
  };
  const s = map[status];
  return (
    <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}
