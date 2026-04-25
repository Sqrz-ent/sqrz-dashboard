import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.payments";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { createClient } from "@supabase/supabase-js";
import { getPlanLevel, FEATURE_GATES } from "~/lib/plans";
import UpgradeBanner from "~/components/UpgradeBanner";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid rgba(245,166,35,0.28)",
  borderRadius: 16,
  padding: "24px 24px",
  marginBottom: 20,
};

const cardHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 20,
};

const cardTitle: React.CSSProperties = {
  fontFamily: FONT_DISPLAY,
  fontSize: 13,
  fontWeight: 800,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.12em",
  margin: 0,
};

const ghostBtn: React.CSSProperties = {
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
};

const accentBtn: React.CSSProperties = {
  padding: "10px 20px",
  background: ACCENT,
  border: "none",
  borderRadius: 10,
  color: "#111111",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: FONT_BODY,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type WalletRow = {
  id: string;
  booking_id: string;
  total_budget: number | null;
  secured_amount: number | null;
  sqrz_fee_pct: number | null;
  client_paid: boolean | null;
  payout_status: string | null;
  status: string | null;
  created_at: string;
  released_amount: number | null;
  currency: string | null;
  booking_title: string;
  booking_status: string | null;
  client_name: string | null;
  client_email: string | null;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });


  const connectStatus = (profile.stripe_connect_status as string | null) ?? "not_connected";
  const connectId = (profile.stripe_connect_id as string | null) ?? null;
  const customerId = (profile.stripe_customer_id as string | null) ?? null;
  const planId = profile.plan_id as number | null;

  const admin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { default: Stripe } = await import("stripe");
  const stripeConnect = new Stripe(process.env.STRIPE_SECRET_KEY!);

  // ── Booking wallets ───────────────────────────────────────────────────────
  const [
    walletsResult,
    stripeExpressResult,
  ] = await Promise.allSettled([
    admin
      .from("booking_wallets")
      .select("id, booking_id, total_budget, secured_amount, sqrz_fee_pct, client_paid, payout_status, status, created_at, released_amount, currency")
      .eq("owner_profile_id", profile.id)
      .order("created_at", { ascending: false }),

    // Stripe Express login link (test key — accounts created in test mode)
    connectId && connectStatus === "active"
      ? stripeConnect.accounts.createLoginLink(connectId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const walletsRaw =
    walletsResult.status === "fulfilled" ? (walletsResult.value.data ?? []) : [];

  const stripeExpressUrl: string | null =
    stripeExpressResult.status === "fulfilled" && stripeExpressResult.value
      ? (stripeExpressResult.value as { url: string }).url
      : null;

  // ── Enrich wallets with booking title + client name ───────────────────────
  let walletRows: WalletRow[] = [];
  if (walletsRaw.length > 0) {
    const bookingIds = walletsRaw.map((w: any) => w.booking_id);

    const [bookingsRes, participantsRes] = await Promise.all([
      admin.from("bookings").select("id, title, status").in("id", bookingIds),
      admin
        .from("booking_participants")
        .select("booking_id, name, email")
        .in("booking_id", bookingIds)
        .eq("role", "buyer"),
    ]);

    const bookingMap = Object.fromEntries(
      (bookingsRes.data ?? []).map((b: any) => [b.id, b])
    );
    const participantMap = Object.fromEntries(
      (participantsRes.data ?? []).map((p: any) => [p.booking_id, p])
    );

    walletRows = walletsRaw.map((w: any): WalletRow => ({
      ...w,
      booking_title: bookingMap[w.booking_id]?.title ?? "Untitled",
      booking_status: bookingMap[w.booking_id]?.status ?? null,
      client_name: participantMap[w.booking_id]?.name ?? null,
      client_email: participantMap[w.booking_id]?.email ?? null,
    }));
  }

  return Response.json(
    { connectStatus, planId, stripeExpressUrl, walletRows },
    { headers }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(amount: number | null | undefined, currency?: string | null) {
  if (amount == null) return "—";
  const cur = (currency ?? "EUR").toUpperCase();
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cur,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const { connectStatus, planId, stripeExpressUrl, walletRows } =
    useLoaderData<typeof loader>() as {
      connectStatus: string;
      planId: number | null;
      stripeExpressUrl: string | null;
      walletRows: WalletRow[];
    };

  const connectFetcher = useFetcher();
  const isConnecting = connectFetcher.state !== "idle";

  const isActive = connectStatus === "active";
  const isPending = connectStatus === "pending";
  const locked = getPlanLevel(planId, false) < FEATURE_GATES.domain;

  // ── Summary metrics ────────────────────────────────────────────────────────
  const totalEarned = walletRows
    .filter(w => w.payout_status === "released")
    .reduce((s, w) => s + (w.released_amount ?? w.secured_amount ?? 0), 0);

  const pendingPayout = walletRows
    .filter(w => w.client_paid && (w.payout_status === "pending" || w.payout_status === "approved"))
    .reduce((s, w) => s + (w.secured_amount ?? 0), 0);

  const awaitingPayment = walletRows
    .filter(w => !w.client_paid)
    .reduce((s, w) => s + (w.secured_amount ?? 0), 0);

  const sqrzFeesPaid = walletRows
    .filter(w => w.client_paid)
    .reduce((s, w) => s + ((w.total_budget ?? 0) - (w.secured_amount ?? 0)), 0);

  // Default currency from most recent wallet with a value
  const defaultCurrency = walletRows.find(w => w.currency)?.currency ?? "EUR";

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 24px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 36,
        fontWeight: 800,
        color: ACCENT,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "0 0 28px",
        lineHeight: 1.1,
      }}>
        Payments
      </h1>

      {locked && (
  <UpgradeBanner planName="Creator plan" upgradeParam="creator" />
)}


<div style={locked ? { opacity: 0.45, pointerEvents: "none" } : {}}> 
      {/* ── Summary cards ── */}
      {walletRows.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 24 }}>
          <MetricCard label="Total Earned" value={fmt(totalEarned, defaultCurrency)} accent />
          <MetricCard label="Pending Payout" value={fmt(pendingPayout, defaultCurrency)} />
          <MetricCard label="Awaiting Payment" value={fmt(awaitingPayment, defaultCurrency)} muted />
          <MetricCard label="SQRZ Fees Paid" value={fmt(sqrzFeesPaid, defaultCurrency)} muted />
        </div>
      )}

      {/* ── Payments table ── */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--border)" }}>
          <p style={cardTitle}>Booking Payments</p>
        </div>

        {walletRows.length === 0 ? (
          <div style={{ padding: "40px 24px", textAlign: "center" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
              No booking payments yet. Payments appear here once a client confirms a booking.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Date", "Booking", "Client", "Total", "Your Rate", "Status", "Action"].map(h => (
                    <th key={h} style={{
                      padding: "10px 16px",
                      textAlign: "left",
                      fontFamily: FONT_DISPLAY,
                      fontSize: 11,
                      fontWeight: 800,
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {walletRows.map((w, i) => {
                  const cur = w.currency ?? defaultCurrency;

                  return (
                    <tr
                      key={w.id}
                      style={{
                        borderBottom: i < walletRows.length - 1 ? "1px solid var(--border)" : "none",
                        background: "transparent",
                      }}
                    >
                      {/* Date */}
                      <td style={{ padding: "14px 16px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {fmtDate(w.created_at)}
                      </td>

                      {/* Booking */}
                      <td style={{ padding: "14px 16px", maxWidth: 180 }}>
                        <a
                          href={`/booking/${w.booking_id}`}
                          style={{ color: "var(--text)", textDecoration: "none", fontWeight: 600 }}
                        >
                          {w.booking_title}
                        </a>
                      </td>

                      {/* Client */}
                      <td style={{ padding: "14px 16px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {w.client_name ?? "—"}
                      </td>

                      {/* Total (what client paid) */}
                      <td style={{ padding: "14px 16px", fontWeight: 600, whiteSpace: "nowrap" }}>
                        {fmt(w.total_budget, cur)}
                      </td>

                      {/* Your rate */}
                      <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                        {fmt(w.secured_amount, cur)}
                      </td>

                      {/* Status */}
                      <td style={{ padding: "14px 16px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <PaymentBadge paid={!!w.client_paid} />
                          <PayoutBadge status={w.payout_status} />
                        </div>
                      </td>

                      {/* Action */}
                      <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                        {w.payout_status === "released" ? (
                          <span style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>Released ✓</span>
                        ) : (
                          <a
                            href={`/booking/${w.booking_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              padding: "6px 14px",
                              background: ACCENT,
                              border: "none",
                              borderRadius: 8,
                              color: "#111",
                              fontSize: 12,
                              fontWeight: 700,
                              fontFamily: FONT_BODY,
                              textDecoration: "none",
                              display: "inline-block",
                            }}
                          >
                            View Booking →
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Section: Client Payments (Connect) ── */}
      <div style={card}>
        <div style={cardHeader}>
          <p style={cardTitle}>Client Payments</p>

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
                  style={ghostBtn}
                >
                  Manage Payouts →
                </a>
              </div>
            ) : (
              <span
                title="Payout dashboard unavailable — Connect account may need re-linking"
                style={{ ...ghostBtn, opacity: 0.4, cursor: "default" }}
              >
                Manage Payouts →
              </span>
            )
          ) : isPending ? (
            <connectFetcher.Form method="post" action="/api/stripe/connect">
              <button
                type="submit"
                disabled={isConnecting}
                style={{ ...ghostBtn, opacity: isConnecting ? 0.6 : 1, cursor: isConnecting ? "default" : "pointer" }}
              >
                {isConnecting ? "Redirecting…" : "Continue Setup →"}
              </button>
            </connectFetcher.Form>
          ) : null}
        </div>

        {!isActive && !isPending && (
          <div style={{ padding: "20px 0 8px", borderTop: "1px solid var(--border)" }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px" }}>
              Connect your bank account to receive payments from clients.
            </p>
            <connectFetcher.Form method="post" action="/api/stripe/connect">
              <button
                type="submit"
                disabled={isConnecting}
                style={{ ...accentBtn, opacity: isConnecting ? 0.6 : 1, cursor: isConnecting ? "default" : "pointer" }}
              >
                {isConnecting ? "Redirecting…" : "Connect Bank Account →"}
              </button>
            </connectFetcher.Form>
          </div>
        )}

        {isPending && (
          <div style={{ padding: "16px 0 4px", borderTop: "1px solid var(--border)" }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Onboarding in progress — finish setting up your Stripe account to receive payouts.
            </p>
          </div>
        )}

        {isActive && (
          <div style={{ padding: "16px 0 4px", borderTop: "1px solid var(--border)" }}>
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

     </div>

    </div>
  );
}


// ─── Sub-components ────────────────────────────────────────────────────────────

function MetricCard({ label, value, accent, muted }: {
  label: string;
  value: string;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <div style={{
      background: "var(--surface)",
      border: `1px solid ${accent ? "rgba(245,166,35,0.4)" : "rgba(245,166,35,0.2)"}`,
      borderRadius: 12,
      padding: "18px 20px",
    }}>
      <p style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 11,
        fontWeight: 800,
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        margin: "0 0 8px",
      }}>{label}</p>
      <p style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 28,
        fontWeight: 800,
        color: accent ? ACCENT : muted ? "var(--text-muted)" : "var(--text)",
        margin: 0,
        lineHeight: 1,
      }}>{value}</p>
    </div>
  );
}

function PaymentBadge({ paid }: { paid: boolean }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      fontSize: 11,
      fontWeight: 600,
      color: paid ? "#22c55e" : "var(--text-muted)",
      background: paid ? "rgba(34,197,94,0.1)" : "var(--surface-muted)",
      borderRadius: 5,
      padding: "2px 7px",
      whiteSpace: "nowrap",
    }}>
      {paid ? "Paid ✓" : "Unpaid"}
    </span>
  );
}

function PayoutBadge({ status }: { status: string | null }) {
  if (!status || status === "pending") {
    return (
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        fontWeight: 600,
        color: "#F3B130",
        background: "rgba(243,177,48,0.1)",
        borderRadius: 5,
        padding: "2px 7px",
        whiteSpace: "nowrap",
      }}>
        Pending
      </span>
    );
  }
  if (status === "approved") {
    return (
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        fontWeight: 600,
        color: "#60a5fa",
        background: "rgba(96,165,250,0.1)",
        borderRadius: 5,
        padding: "2px 7px",
        whiteSpace: "nowrap",
      }}>
        Approved
      </span>
    );
  }
  if (status === "released") {
    return (
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        fontWeight: 600,
        color: "#22c55e",
        background: "rgba(34,197,94,0.1)",
        borderRadius: 5,
        padding: "2px 7px",
        whiteSpace: "nowrap",
      }}>
        Released ✓
      </span>
    );
  }
  if (status === "disputed") {
    return (
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        fontWeight: 600,
        color: "#ef4444",
        background: "rgba(239,68,68,0.1)",
        borderRadius: 5,
        padding: "2px 7px",
        whiteSpace: "nowrap",
      }}>
        Disputed
      </span>
    );
  }
  return null;
}

