import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.payments";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";
import Stripe from "stripe";

// Connect accounts were created in test mode — use test key for Express login links
const stripeTest = new Stripe(process.env.STRIPE_SECRET_KEY_TEST!);

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

type SubInfo = {
  planName: string | null;
  interval: "month" | "year" | null;
  amount: number | null;
  currency: string | null;
  nextBilling: number | null; // unix timestamp
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

  // ── Stripe Express login link (test key — accounts created in test mode) ──
  let stripeExpressUrl: string | null = null;
  if (connectId && connectStatus === "active") {
    try {
      const loginLink = await stripeTest.accounts.createLoginLink(connectId);
      stripeExpressUrl = loginLink.url;
    } catch (e) {
      console.error("[payments] Stripe Express link failed:", e);
    }
  }

  // ── Stripe billing portal URL ─────────────────────────────────────────────
  let billingPortalUrl: string | null = null;
  if (customerId) {
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com"}/payments`,
      });
      billingPortalUrl = session.url;
    } catch (e) {
      console.error("[payments] Billing portal failed:", e);
    }
  }

  // ── Subscription info ────────────────────────────────────────────────────
  let subInfo: SubInfo = {
    planName: null,
    interval: null,
    amount: null,
    currency: null,
    nextBilling: null,
  };

  // Plan name from DB
  if (planId) {
    const { data: plan } = await supabase
      .from("plans")
      .select("name")
      .eq("id", planId)
      .maybeSingle();
    subInfo.planName = (plan?.name as string) ?? null;
  }

  // Billing details from Stripe
  if (customerId) {
    try {
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: "active",
        limit: 1,
        expand: ["data.items.data.price"],
      });
      const sub = subs.data[0];
      if (sub) {
        const price = sub.items.data[0]?.price;
        subInfo.interval = (price?.recurring?.interval as "month" | "year") ?? null;
        subInfo.amount = price?.unit_amount ?? null;
        subInfo.currency = price?.currency ?? null;
        subInfo.nextBilling = (sub as any).current_period_end ?? sub.items.data[0]?.current_period_end ?? null;
      }
    } catch {
      // Non-fatal
    }
  }

  return Response.json(
    { connectStatus, subInfo, planId, stripeExpressUrl, billingPortalUrl },
    { headers }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const { connectStatus, subInfo, planId, stripeExpressUrl, billingPortalUrl } =
    useLoaderData<typeof loader>() as {
      connectStatus: string;
      subInfo: SubInfo;
      planId: number | null;
      stripeExpressUrl: string | null;
      billingPortalUrl: string | null;
    };

  const connectFetcher = useFetcher();
  const isConnecting = connectFetcher.state !== "idle";

  const isActive = connectStatus === "active";
  const isPending = connectStatus === "pending";
  const hasPlan = !!planId && planId > 0;

  const planLabel = subInfo.planName
    ? [
        subInfo.planName,
        subInfo.amount && subInfo.currency
          ? `${formatAmount(subInfo.amount, subInfo.currency)}/${subInfo.interval === "year" ? "yr" : "mo"}`
          : null,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 24px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
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

      {/* ── Section 1: Client Payments ── */}
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

      {/* ── Section 2: SQRZ Subscription ── */}
      <div style={card}>
        <div style={cardHeader}>
          <p style={cardTitle}>Your SQRZ Plan</p>

          {hasPlan && (
            billingPortalUrl ? (
              <a
                href={billingPortalUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={ghostBtn}
              >
                Manage Billing →
              </a>
            ) : (
              <span
                title="Billing portal unavailable — contact support"
                style={{ ...ghostBtn, opacity: 0.4, cursor: "default" }}
              >
                Manage Billing →
              </span>
            )
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          {!hasPlan ? (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              You're on the free plan.{" "}
              <a href="/?upgrade=1" style={{ color: ACCENT, textDecoration: "none", fontWeight: 600 }}>
                Upgrade to Creator →
              </a>
            </p>
          ) : (
            <>
              {planLabel && (
                <p style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: "0 0 6px" }}>
                  {planLabel}
                </p>
              )}
              {subInfo.nextBilling && (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                  Next billing: {formatDate(subInfo.nextBilling)}
                </p>
              )}
              {!subInfo.nextBilling && subInfo.planName && (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                  {subInfo.planName}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
