import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.payments";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";
import { getPlanLevel } from "~/lib/plans";
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
  position: "relative",
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

// ─── Types ────────────────────────────────────────────────────────────────────

type InvoiceRow = {
  id: string;
  created: number;
  amount_paid: number;
  currency: string;
  status: string | null;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
  description: string | null;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const planLevel = getPlanLevel(profile.plan_id as number | null, profile.is_beta as boolean);
  const connectStatus = (profile.stripe_connect_status as string | null) ?? "not_connected";
  const connectId = (profile.stripe_connect_id as string | null) ?? null;
  const customerId = (profile.stripe_customer_id as string | null) ?? null;

  let invoices: InvoiceRow[] = [];

  if (planLevel >= 1 && customerId) {
    try {
      const result = await stripe.invoices.list({ customer: customerId, limit: 20 });
      invoices = result.data.map((inv) => ({
        id: inv.id,
        created: inv.created,
        amount_paid: inv.amount_paid,
        currency: inv.currency,
        status: inv.status ?? null,
        invoice_pdf: inv.invoice_pdf ?? null,
        hosted_invoice_url: inv.hosted_invoice_url ?? null,
        description: inv.description ?? null,
      }));
    } catch {
      // Non-fatal — show empty state
    }
  }

  return Response.json(
    {
      planLevel,
      connectStatus,
      connectId,
      invoices,
    },
    { headers }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(unix: number) {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount / 100);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const { planLevel, connectStatus, invoices } =
    useLoaderData<typeof loader>() as {
      planLevel: number;
      connectStatus: string;
      connectId: string | null;
      invoices: InvoiceRow[];
    };

  const connectFetcher = useFetcher();
  const loginFetcher = useFetcher();

  const isConnecting = connectFetcher.state !== "idle";
  const isOpeningDashboard = loginFetcher.state !== "idle";

  const isActive = connectStatus === "active";
  const isPending = connectStatus === "pending";

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 24px", fontFamily: FONT_BODY }}>
      <h1 style={{ ...sectionTitle, fontSize: 36, marginBottom: 6 }}>Payments</h1>
      <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 28px" }}>
        Connect your bank account and manage invoices.
      </p>

      {planLevel < 1 && (
        <UpgradeBanner planName="Creator plan" upgradeParam="1" />
      )}

      {/* ── Section A: Stripe Connect ── */}
      <div style={card}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" }}>
          Stripe Connect
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 18px" }}>
          Connect your bank account to receive payouts from bookings.
        </p>

        {isActive ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <span style={{ color: "#4ade80", fontSize: 14, fontWeight: 600 }}>
              ✓ Payments active
            </span>
            <loginFetcher.Form method="post" action="/api/stripe/connect/login">
              <button
                type="submit"
                disabled={isOpeningDashboard || planLevel < 1}
                style={{
                  padding: "9px 18px",
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  color: "var(--text)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: isOpeningDashboard ? "default" : "pointer",
                  fontFamily: FONT_BODY,
                }}
              >
                {isOpeningDashboard ? "Opening…" : "Manage payouts →"}
              </button>
            </loginFetcher.Form>
          </div>
        ) : isPending ? (
          <div>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px" }}>
              Onboarding in progress — finish setting up your account to receive payouts.
            </p>
            <connectFetcher.Form method="post" action="/api/stripe/connect">
              <button
                type="submit"
                disabled={isConnecting || planLevel < 1}
                style={{
                  padding: "11px 22px",
                  background: "var(--surface-muted)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  color: isConnecting ? "var(--text-muted)" : "var(--text)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: isConnecting ? "default" : "pointer",
                  fontFamily: FONT_BODY,
                }}
              >
                {isConnecting ? "Redirecting…" : "Continue setup →"}
              </button>
            </connectFetcher.Form>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px" }}>
              You're not connected yet. Connect Stripe to get paid directly through SQRZ.
            </p>
            <connectFetcher.Form method="post" action="/api/stripe/connect">
              <button
                type="submit"
                disabled={isConnecting || planLevel < 1}
                style={{
                  padding: "12px 24px",
                  background: planLevel >= 1 ? ACCENT : "var(--surface-muted)",
                  border: "none",
                  borderRadius: 10,
                  color: planLevel >= 1 ? "#111111" : "var(--text-muted)",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: isConnecting || planLevel < 1 ? "default" : "pointer",
                  opacity: isConnecting ? 0.6 : 1,
                  fontFamily: FONT_BODY,
                }}
              >
                {isConnecting ? "Redirecting…" : "Connect Stripe →"}
              </button>
            </connectFetcher.Form>
          </div>
        )}
      </div>

      {/* ── Section B: Invoices ── */}
      <div style={card}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" }}>
          Invoices
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 18px" }}>
          Your SQRZ subscription billing history.
        </p>

        {planLevel < 1 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
            Upgrade to Creator to access invoices.
          </p>
        ) : invoices.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
            No invoices yet — they'll appear here once you start getting booked.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {invoices.map((inv, i) => (
              <div
                key={inv.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 0",
                  borderBottom: i < invoices.length - 1 ? "1px solid var(--border)" : "none",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <p style={{ margin: 0, fontSize: 14, color: "var(--text)", fontWeight: 500 }}>
                    {formatDate(inv.created)}
                  </p>
                  {inv.description && (
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                      {inv.description}
                    </p>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                    {formatAmount(inv.amount_paid, inv.currency)}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: 20,
                      background: inv.status === "paid"
                        ? "rgba(74,222,128,0.12)"
                        : "rgba(245,166,35,0.12)",
                      color: inv.status === "paid" ? "#4ade80" : ACCENT,
                    }}
                  >
                    {inv.status ?? "—"}
                  </span>
                  {(inv.invoice_pdf || inv.hosted_invoice_url) && (
                    <a
                      href={(inv.invoice_pdf ?? inv.hosted_invoice_url)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 12, color: ACCENT, textDecoration: "none", fontWeight: 600 }}
                    >
                      PDF ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
