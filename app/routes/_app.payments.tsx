import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.payments";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { createClient } from "@supabase/supabase-js";
import { getPlanLevel, FEATURE_GATES } from "~/lib/plans";
import UpgradeBanner from "~/components/UpgradeBanner";
import { getStripeClient } from "~/lib/stripe-mode.server";

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
  stripe_mode: "live" | "test" | null;
  client_payment_method: string | null;
  booking_title: string;
  booking_status: string | null;
  client_name: string | null;
  client_email: string | null;
};

// Unified row used by the merged payments list (bookings + link payments).
type PaymentRow = {
  id: string;
  kind: "booking" | "link";
  date: string;
  name: string;
  href: string;
  total: number | null;
  currency: string | null;
  method: "stripe" | "manual";
  status: "paid" | "unpaid" | "awaiting";
  isTest: boolean;
};

type ConnectDiagnostics = {
  detailsSubmitted: boolean | null;
  payoutsEnabled: boolean | null;
  chargesEnabled: boolean | null;
  currentlyDue: string[];
  disabledReason: string | null;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });
  const url = new URL(request.url);

  const profileId = profile.id as string;
  let connectStatus = (profile.stripe_connect_status as string | null) ?? "not_connected";
  const connectId = (profile.stripe_connect_id as string | null) ?? null;
  const planId = profile.plan_id as number | null;

  const admin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const stripeConnect = getStripeClient("live");

  const connectResult = url.searchParams.get("connect");
  let connectDiagnostics: ConnectDiagnostics | null = null;

  // Live-only Connect status sync — retrieves the account from Stripe and persists
  // the derived status (active | pending) on the profile.
  async function syncConnectStatus() {
    if (!stripeConnect || !connectId) return null;

    const account = await stripeConnect.accounts.retrieve(connectId);
    const nextStatus = account.charges_enabled && account.payouts_enabled ? "active" : "pending";
    const diagnostics = {
      detailsSubmitted: account.details_submitted ?? null,
      payoutsEnabled: account.payouts_enabled ?? null,
      chargesEnabled: account.charges_enabled ?? null,
      currentlyDue: account.requirements?.currently_due ?? [],
      disabledReason: account.requirements?.disabled_reason ?? null,
    };

    await admin
      .from("profiles")
      .update({ stripe_connect_status: nextStatus })
      .eq("id", profileId);

    connectStatus = nextStatus;
    connectDiagnostics = diagnostics;
    return diagnostics;
  }

  if (connectResult === "success" || connectResult === "refresh") {
    await syncConnectStatus();
  }

  if (!connectDiagnostics && stripeConnect && connectId && (connectStatus === "pending" || connectStatus === "active")) {
    connectDiagnostics = await syncConnectStatus();
  }

  // ── Booking wallets ───────────────────────────────────────────────────────
  const [
    walletsResult,
    stripeExpressResult,
  ] = await Promise.allSettled([
    admin
      .from("booking_wallets")
      .select("id, booking_id, total_budget, secured_amount, sqrz_fee_pct, client_paid, payout_status, status, created_at, released_amount, currency, stripe_mode, client_payment_method")
      .eq("owner_profile_id", profile.id)
      .order("created_at", { ascending: false }),

    // Stripe Express login link for the live, active Connect account.
    stripeConnect && connectId && connectStatus === "active"
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

  // ── Link payments (payment-gated private links) ───────────────────────────
  const { data: linkPaymentsRaw } = await admin
    .from("link_payments")
    .select("id, created_at, link_id, amount, currency, stripe_mode")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false });

  let linkTitleMap: Record<string, string> = {};
  if (linkPaymentsRaw && linkPaymentsRaw.length > 0) {
    const linkIds = [...new Set(linkPaymentsRaw.map((p: any) => p.link_id).filter(Boolean))];
    const { data: linksData } = await admin
      .from("private_booking_links")
      .select("id, title")
      .in("id", linkIds);
    linkTitleMap = Object.fromEntries((linksData ?? []).map((l: any) => [l.id, l.title]));
  }

  // ── Merge into one unified, date-sorted list ──────────────────────────────
  const payments: PaymentRow[] = [
    ...walletRows.map((w): PaymentRow => ({
      id: `w_${w.id}`,
      kind: "booking",
      date: w.created_at,
      name: w.booking_title,
      href: `/booking/${w.booking_id}`,
      total: w.total_budget,
      currency: w.currency,
      method: w.client_payment_method === "manual" ? "manual" : "stripe",
      // paid → money received; manual-unpaid → "unpaid"; stripe-unpaid → "awaiting"
      status: w.client_paid ? "paid" : (w.client_payment_method === "manual" ? "unpaid" : "awaiting"),
      isTest: w.stripe_mode === "test",
    })),
    ...(linkPaymentsRaw ?? []).map((p: any): PaymentRow => ({
      id: `l_${p.id}`,
      kind: "link",
      date: p.created_at,
      name: linkTitleMap[p.link_id] ?? "Private link",
      href: "/links",
      total: p.amount,
      currency: p.currency,
      method: "stripe", // link payments are always Stripe (PaymentGateCta)
      status: "paid",    // a link_payments row only exists after a successful charge
      isTest: p.stripe_mode === "test",
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // ── Summary totals ────────────────────────────────────────────────────────
  // Total Earned counts Stripe-processed money only (manual/bank-transfer
  // payments are settled off-platform, so their amounts are not tracked here).
  const totalEarned =
    walletRows
      .filter((w) => w.client_paid && w.client_payment_method !== "manual")
      .reduce((s, w) => s + (w.secured_amount ?? 0), 0) +
    (linkPaymentsRaw ?? []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);

  const awaitingPayment = walletRows
    .filter((w) => !w.client_paid)
    .reduce((s, w) => s + (w.secured_amount ?? 0), 0);

  const defaultCurrency =
    walletRows.find((w) => w.currency)?.currency ??
    (linkPaymentsRaw ?? []).find((p: any) => p.currency)?.currency ??
    "EUR";

  return Response.json(
    {
      connectStatus,
      planId,
      stripeExpressUrl,
      payments,
      totalEarned,
      awaitingPayment,
      defaultCurrency,
    },
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
  const {
    connectStatus,
    planId,
    stripeExpressUrl,
    payments,
    totalEarned,
    awaitingPayment,
    defaultCurrency,
  } =
    useLoaderData<typeof loader>() as {
      connectStatus: string;
      planId: number | null;
      stripeExpressUrl: string | null;
      payments: PaymentRow[];
      totalEarned: number;
      awaitingPayment: number;
      defaultCurrency: string;
    };

  const connectFetcher = useFetcher();
  const isConnecting = connectFetcher.state !== "idle";

  const isActive = connectStatus === "active";
  const locked = getPlanLevel(planId) < FEATURE_GATES.payments;

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
      {payments.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 24, alignItems: "start" }}>
          <div>
            <MetricCard label="Total Earned" value={fmt(totalEarned, defaultCurrency)} accent />
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 2px 0", lineHeight: 1.4 }}>
              Stripe payments only
            </p>
          </div>
          <MetricCard label="Awaiting Payment" value={fmt(awaitingPayment, defaultCurrency)} muted />
        </div>
      )}

      {/* ── Unified payments list ── */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--border)" }}>
          <p style={cardTitle}>Payments</p>
        </div>

        {payments.length === 0 ? (
          <div style={{ padding: "40px 24px", textAlign: "center" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
              No payments yet. Booking and link payments appear here once a client pays.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Date", "Name", "Total", "Method", "Status"].map(h => (
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
                {payments.map((p, i) => (
                  <tr
                    key={p.id}
                    style={{
                      borderBottom: i < payments.length - 1 ? "1px solid var(--border)" : "none",
                      background: "transparent",
                    }}
                  >
                    {/* Date */}
                    <td style={{ padding: "14px 16px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {fmtDate(p.date)}
                    </td>

                    {/* Name — clickable link to the booking or links page */}
                    <td style={{ padding: "14px 16px", maxWidth: 220 }}>
                      <a
                        href={p.href}
                        style={{ color: "var(--text)", textDecoration: "none", fontWeight: 600 }}
                      >
                        {p.name}
                      </a>
                      {p.isTest && (
                        <span style={{
                          display: "inline-flex",
                          marginLeft: 8,
                          padding: "2px 7px",
                          borderRadius: 999,
                          background: "rgba(245,166,35,0.12)",
                          border: "1px solid rgba(245,166,35,0.28)",
                          color: ACCENT,
                          fontSize: 10,
                          fontWeight: 800,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                        }}>
                          Test
                        </span>
                      )}
                    </td>

                    {/* Total */}
                    <td style={{ padding: "14px 16px", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {fmt(p.total, p.currency ?? defaultCurrency)}
                    </td>

                    {/* Method pill */}
                    <td style={{ padding: "14px 16px" }}>
                      <MethodBadge method={p.method} />
                    </td>

                    {/* Status pill */}
                    <td style={{ padding: "14px 16px" }}>
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Section: Stripe Connect (payouts) ── */}
      <div style={card}>
        <div style={cardHeader}>
          <p style={cardTitle}>Stripe Connect</p>

          {isActive && (
            stripeExpressUrl ? (
              <a href={stripeExpressUrl} target="_blank" rel="noopener noreferrer" style={ghostBtn}>
                Manage Payouts →
              </a>
            ) : (
              <span
                title="Payout dashboard unavailable — Connect account may need re-linking"
                style={{ ...ghostBtn, opacity: 0.4, cursor: "default" }}
              >
                Manage Payouts →
              </span>
            )
          )}
        </div>

        {isActive ? (
          <div style={{ padding: "16px 0 4px", borderTop: "1px solid var(--border)" }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Your Stripe account is connected. Payout history is available in the{" "}
              {stripeExpressUrl ? (
                <a href={stripeExpressUrl} target="_blank" rel="noopener noreferrer" style={{ color: ACCENT, textDecoration: "none", fontWeight: 600 }}>
                  Stripe Express dashboard →
                </a>
              ) : (
                <span style={{ color: "var(--text-muted)" }}>Stripe Express dashboard</span>
              )}
            </p>
          </div>
        ) : (
          <div style={{ padding: "20px 0 8px", borderTop: "1px solid var(--border)" }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px" }}>
              Connect your Stripe account to receive payments from clients.
            </p>
            <connectFetcher.Form method="post" action="/api/stripe/connect">
              <button
                type="submit"
                disabled={isConnecting}
                style={{ ...accentBtn, opacity: isConnecting ? 0.6 : 1, cursor: isConnecting ? "default" : "pointer" }}
              >
                {isConnecting ? "Redirecting…" : "Connect with Stripe →"}
              </button>
            </connectFetcher.Form>
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

const pillBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 5,
  padding: "2px 8px",
  whiteSpace: "nowrap",
};

function MethodBadge({ method }: { method: "stripe" | "manual" }) {
  const isStripe = method === "stripe";
  return (
    <span style={{
      ...pillBase,
      color: isStripe ? "#635bff" : "var(--text-muted)",
      background: isStripe ? "rgba(99,91,255,0.12)" : "var(--surface-muted)",
    }}>
      {isStripe ? "Stripe" : "Manual"}
    </span>
  );
}

function StatusBadge({ status }: { status: "paid" | "unpaid" | "awaiting" }) {
  if (status === "paid") {
    return <span style={{ ...pillBase, color: "#22c55e", background: "rgba(34,197,94,0.1)" }}>Paid ✓</span>;
  }
  if (status === "awaiting") {
    return <span style={{ ...pillBase, color: "#F3B130", background: "rgba(243,177,48,0.1)" }}>Awaiting</span>;
  }
  return <span style={{ ...pillBase, color: "var(--text-muted)", background: "var(--surface-muted)" }}>Unpaid</span>;
}
