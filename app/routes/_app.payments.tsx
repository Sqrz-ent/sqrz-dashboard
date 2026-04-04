import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.payments";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";

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

type ClientPayment = {
  id: string;
  title: string | null;
  guest_name: string | null;
  guest_email: string | null;
  amount: number;
  currency: string;
  created_at: string;
};

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

  // ── Stripe Express login link ─────────────────────────────────────────────
  let stripeExpressUrl: string | null = null;
  if (connectId && connectStatus === "active") {
    try {
      const loginLink = await stripe.accounts.createLoginLink(connectId);
      stripeExpressUrl = loginLink.url;
    } catch {
      // Non-fatal
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
    } catch {
      // Non-fatal
    }
  }

  // ── Client payments ──────────────────────────────────────────────────────
  let clientPayments: ClientPayment[] = [];
  try {
    const { data: payments } = await supabase
      .from("payments")
      .select("id, title, amount, currency, created_at, booking:bookings(guest_name, guest_email)")
      .eq("profile_id", profile.id as string)
      .eq("status", "paid")
      .order("created_at", { ascending: false })
      .limit(50);

    if (payments) {
      clientPayments = payments.map((p: any) => ({
        id: p.id,
        title: p.title ?? null,
        guest_name: p.booking?.guest_name ?? null,
        guest_email: p.booking?.guest_email ?? null,
        amount: p.amount,
        currency: p.currency ?? "usd",
        created_at: p.created_at,
      }));
    }
  } catch {
    // Non-fatal
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
    { connectStatus, clientPayments, subInfo, planId, stripeExpressUrl, billingPortalUrl },
    { headers }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

function formatDateStr(str: string) {
  return new Date(str).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
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
  const { connectStatus, clientPayments, subInfo, planId, stripeExpressUrl, billingPortalUrl } =
    useLoaderData<typeof loader>() as {
      connectStatus: string;
      clientPayments: ClientPayment[];
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

          {isActive && stripeExpressUrl ? (
            <a
              href={stripeExpressUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={ghostBtn}
            >
              Manage Payouts →
            </a>
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
          <>
            {clientPayments.length === 0 ? (
              <div style={{ padding: "28px 0", textAlign: "center", borderTop: "1px solid var(--border)" }}>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                  No client payments yet. Send a proposal to get started.
                </p>
              </div>
            ) : (
              <div style={{ borderTop: "1px solid var(--border)" }}>
                {clientPayments.map((p, i) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "13px 0",
                      borderBottom: i < clientPayments.length - 1 ? "1px solid var(--border)" : "none",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.title ?? "Booking"}
                      </p>
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                        {p.guest_name ?? p.guest_email ?? "Client"} · {formatDateStr(p.created_at)}
                      </p>
                    </div>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#4ade80", flexShrink: 0 }}>
                      {formatAmount(p.amount, p.currency)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Section 2: SQRZ Subscription ── */}
      <div style={card}>
        <div style={cardHeader}>
          <p style={cardTitle}>Your SQRZ Plan</p>

          {hasPlan && billingPortalUrl && (
            <a
              href={billingPortalUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={ghostBtn}
            >
              Manage Billing →
            </a>
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
