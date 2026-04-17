import { useState } from "react";
import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.office.partners";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const PURPLE = "#a855f7";
const PURPLE_BG = "rgba(168,85,247,0.12)";
const AMBER = "#fbbf24";
const GREEN = "#4ade80";

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

type ReferralStatus = "signed_up" | "subscribed" | "active" | "expired";

type Referral = {
  slug: string;
  planLabel: string;
  lastActivity: string | null;
  earned: number;
  status: ReferralStatus;
};

type LoaderData = {
  refCode: string | null;
  commissionPct: number;
  tier: "Starter" | "Pro" | "Elite";
  referrals: Referral[];
  stats: { signedUp: number; subscribed: number; activeWindow: number; paidOut: number };
  earnings: { lifetime: number; pending: number; paid: number };
  activeCount: number;
  nextTierCount: number | null;
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

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
    .select("id, slug, plan_id, updated_at")
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

  // Build referral rows (merge uses + profiles in JS)
  const now = Date.now();
  const referrals: Referral[] = (rawUses ?? []).map((u) => {
    const prof = (referredProfiles ?? []).find((p) => p.id === u.referred_profile_id);
    const slug = (prof?.slug as string | null) ?? "unknown";
    const plan = (prof?.plan_id as number | null) ?? null;
    const lastActivity = (prof?.updated_at as string | null) ?? null;
    const earned = earnedByProfile[(u.referred_profile_id as string)] ?? 0;
    const commissionEndsAt = u.commission_ends_at as string | null;
    const converted = !!(u.converted);

    let status: ReferralStatus;
    if (!converted) {
      status = "signed_up";
    } else if (commissionEndsAt && new Date(commissionEndsAt).getTime() > now) {
      status = "active";
    } else if (earned > 0) {
      status = "expired";
    } else {
      status = "subscribed";
    }

    return { slug, planLabel: planLabel(plan), lastActivity, earned, status };
  });

  // Stats
  const stats = {
    signedUp: referrals.filter((r) => r.status === "signed_up").length,
    subscribed: referrals.filter((r) => r.status === "subscribed").length,
    activeWindow: referrals.filter((r) => r.status === "active").length,
    paidOut: referrals.filter((r) => r.status === "expired" && r.earned > 0).length,
  };

  const activeCount = stats.activeWindow;
  const tier = tierFromPct(commissionPct);
  const nextTierCount = tier === "Elite" ? null : tier === "Pro" ? 15 : 5;

  return Response.json(
    {
      refCode,
      commissionPct,
      tier,
      referrals,
      stats,
      earnings: { lifetime: lifetimeEarned, pending: paidTotal.pending, paid: paidTotal.paid },
      activeCount,
      nextTierCount,
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
  } = useLoaderData<typeof loader>() as LoaderData;

  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<ReferralStatus | "all">("all");

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

  const filteredReferrals = filter === "all" || filter === "signed_up"
    ? referrals
    : referrals.filter((r) => {
        if (filter === "active") return r.status === "active";
        if (filter === "subscribed") return r.status === "subscribed";
        if (filter === "expired") return r.status === "expired";
        return true;
      });

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 20px 100px", fontFamily: FONT_BODY, color: "var(--text)" }}>

      {/* ── Section 1: Header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", color: "var(--text)" }}>Partner program</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
            Earn {commissionPct}% of every subscription you bring in, for 12 months
          </p>
        </div>
        <span style={{
          padding: "4px 12px",
          borderRadius: 20,
          background: PURPLE_BG,
          color: PURPLE,
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
          <span style={{ flex: 1, color: "var(--text)", fontSize: 13, fontFamily: "monospace", wordBreak: "break-all" }}>
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

      {/* ── Section 3: Earnings cards ─────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        <div style={card}>
          <span style={lbl}>Lifetime earned</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "var(--text)" }}>{fmtMoney(earnings.lifetime)}</p>
        </div>
        <div style={{ ...card, borderColor: earnings.pending > 0 ? "rgba(251,191,36,0.3)" : "var(--border)" }}>
          <span style={lbl}>Pending payout</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: "0 0 2px", color: earnings.pending > 0 ? AMBER : "var(--text)" }}>
            {fmtMoney(earnings.pending)}
          </p>
          {earnings.pending >= 25 ? (
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>Next batch {nextMonth()}</p>
          ) : (
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>€25 minimum</p>
          )}
        </div>
        <div style={{ ...card, borderColor: earnings.paid > 0 ? "rgba(74,222,128,0.3)" : "var(--border)" }}>
          <span style={lbl}>Total paid out</span>
          <p style={{ fontSize: 22, fontWeight: 700, margin: 0, color: earnings.paid > 0 ? GREEN : "var(--text)" }}>{fmtMoney(earnings.paid)}</p>
        </div>
      </div>

      {/* ── Section 4: Tier progress ─────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>
            {tier === "Elite"
              ? "Maximum tier reached"
              : `${activeCount} of ${nextTierCount} active referrals to ${tier === "Starter" ? "Pro" : "Elite"} (${tier === "Starter" ? 40 : 50}%)`}
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
                  background: isCurrent ? PURPLE_BG : "transparent",
                  color: isCurrent ? PURPLE : isNext ? PURPLE : "var(--text-muted)",
                  border: isCurrent ? `1px solid ${PURPLE}` : isNext ? `1px solid rgba(168,85,247,0.4)` : "1px solid var(--border)",
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
              <div style={{ height: "100%", width: `${progress * 100}%`, background: PURPLE, borderRadius: 6, transition: "width 0.4s ease" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{activeCount} active now</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {(tierThresholds[tier] ?? 0) - activeCount > 0
                  ? `${(tierThresholds[tier] ?? 0) - activeCount} to unlock ${tier === "Starter" ? "Pro" : "Elite"} · ${tierThresholds["Pro"]} for Elite`
                  : `Qualifying for ${tier === "Starter" ? "Pro" : "Elite"}`}
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Section 5: Funnel cards ───────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
        {(
          [
            { key: "signed_up" as const, label: "Signed up", count: stats.signedUp + stats.subscribed + stats.activeWindow + stats.paidOut },
            { key: "subscribed" as const, label: "Subscribed", count: stats.subscribed + stats.activeWindow + stats.paidOut },
            { key: "active" as const, label: "Active window", count: stats.activeWindow },
            { key: "expired" as const, label: "Paid out", count: stats.paidOut },
          ] as const
        ).map(({ key, label, count }) => {
          const isActive = filter === key || (filter === "all" && key === "signed_up");
          return (
            <button
              key={key}
              onClick={() => setFilter(filter === key ? "all" : key)}
              style={{
                background: "var(--surface)",
                border: isActive ? `1.5px solid ${PURPLE}` : "1px solid var(--border)",
                borderRadius: 10,
                padding: "12px 14px",
                cursor: "pointer",
                textAlign: "left",
                color: "var(--text)",
                fontFamily: FONT_BODY,
              }}
            >
              <p style={{ fontSize: 18, fontWeight: 700, margin: "0 0 2px", color: isActive ? PURPLE : "var(--text)" }}>{count}</p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</p>
            </button>
          );
        })}
      </div>

      {/* ── Section 6: Referrals table ────────────────────────────────────── */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--surface-muted)", borderBottom: "1px solid var(--border)" }}>
              {["Referral", "Plan", "Last activity", "Your earnings", "Status"].map((h) => (
                <th key={h} style={{ ...lbl, padding: "10px 14px", textAlign: "left", margin: 0 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredReferrals.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: "28px 14px", color: "var(--text-muted)", textAlign: "center" }}>
                  No referrals yet. Share your link to get started.
                </td>
              </tr>
            ) : (
              filteredReferrals.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "11px 14px", fontFamily: "monospace", color: "var(--text)", fontWeight: 600 }}>
                    {r.slug}
                  </td>
                  <td style={{ padding: "11px 14px" }}>
                    {r.status === "signed_up" ? (
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
                  <td style={{ padding: "11px 14px", color: "var(--text-muted)" }}>
                    {fmtDate(r.lastActivity)}
                  </td>
                  <td style={{ padding: "11px 14px" }}>
                    {r.status === "signed_up" ? (
                      <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>not subscribed</span>
                    ) : (
                      <span style={{ fontWeight: r.earned > 0 ? 700 : 400, color: r.earned > 0 ? "var(--text)" : "var(--text-muted)" }}>
                        {fmtMoney(r.earned)}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "11px 14px" }}>
                    <StatusPill status={r.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ReferralStatus }) {
  const map: Record<ReferralStatus, { label: string; bg: string; color: string }> = {
    signed_up:  { label: "Signed up",     bg: "var(--surface-muted)",      color: "var(--text-muted)" },
    subscribed: { label: "Subscribed",    bg: "rgba(96,165,250,0.12)",     color: "#60a5fa"           },
    active:     { label: "Active",        bg: PURPLE_BG,                   color: PURPLE              },
    expired:    { label: "Window expired",bg: "rgba(251,191,36,0.12)",     color: AMBER               },
  };
  const s = map[status];
  return (
    <span style={{ padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}
