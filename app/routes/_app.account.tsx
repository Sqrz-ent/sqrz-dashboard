import { useState, useEffect } from "react";
import { redirect, useLoaderData, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/_app.account";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase } from "~/lib/supabase.client";

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

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.07em",
  display: "block",
  marginBottom: 4,
  fontFamily: FONT_BODY,
};

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const [subRes, planRes] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("*")
      .eq("profile_id", profile.id as string)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    profile.plan_id
      ? supabase
          .from("plans")
          .select("id, name")
          .eq("id", profile.plan_id as number)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const sub = subRes.data;
  const customerId = profile.stripe_customer_id as string | null;

  // Fetch Stripe price info + billing portal in parallel
  const { default: Stripe } = await import("stripe");
  const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);

  let stripePrice: { amount: number | null; interval: string | null; currency: string | null } = {
    amount: null, interval: null, currency: null,
  };
  let billingPortalUrl: string | null = null;

  await Promise.all([
    sub?.stripe_price_id
      ? stripeClient.prices.retrieve(sub.stripe_price_id as string)
          .then((p) => {
            stripePrice = {
              amount: p.unit_amount ?? null,
              interval: (p as any).recurring?.interval ?? null,
              currency: p.currency ?? null,
            };
          })
          .catch(() => {})
      : Promise.resolve(),
    customerId
      ? stripeClient.billingPortal.sessions.create({
          customer: customerId,
          return_url: `${process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com"}/account`,
        })
          .then((s) => { billingPortalUrl = s.url; })
          .catch(() => {})
      : Promise.resolve(),
  ]);

  return Response.json(
    {
      profile,
      subscription: sub ?? null,
      plan: planRes.data ?? null,
      stripePrice,
      billingPortalUrl,
    },
    { headers }
  );
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "sign_out") {
    await supabase.auth.signOut();
    return redirect("/login", { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

function StatusBadge({ status }: { status: string }) {
  let bg = "rgba(245,166,35,0.12)";
  let color = ACCENT;
  let label = status;

  if (status === "active") {
    bg = "rgba(34,197,94,0.12)";
    color = "#22c55e";
    label = "Active";
  } else if (status === "past_due") {
    bg = "rgba(245,166,35,0.12)";
    color = ACCENT;
    label = "Past Due";
  } else if (status === "canceled" || status === "cancelled") {
    bg = "rgba(239,68,68,0.12)";
    color = "#ef4444";
    label = "Cancelled";
  }

  return (
    <span style={{
      display: "inline-block",
      padding: "3px 10px",
      background: bg,
      borderRadius: 8,
      fontSize: 11,
      fontWeight: 700,
      color,
      fontFamily: FONT_BODY,
      letterSpacing: "0.04em",
    }}>
      {label}
    </span>
  );
}

function fmtPrice(amount: number | null, currency: string | null, interval: string | null) {
  if (!amount || !currency) return null;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount / 100);
  const suffix = interval === "year" ? "/yr" : "/mo";
  return `${formatted}${suffix}`;
}

export default function AccountPage() {
  const { profile, subscription, plan, stripePrice, billingPortalUrl } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
    subscription: Record<string, unknown> | null;
    plan: { id: number; name: string } | null;
    stripePrice: { amount: number | null; interval: string | null; currency: string | null };
    billingPortalUrl: string | null;
  };

  const [searchParams] = useSearchParams();
  const signOutFetcher = useFetcher();

  useEffect(() => {
    if (searchParams.get("upgrade") === "true") {
      const el = document.getElementById("subscription-card");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [searchParams]);

  // Cancellation state (optimistic update on cancel)
  const [cancelledAt, setCancelledAt] = useState<string | null>(
    (subscription?.cancelled_at as string | null) ?? null
  );
  const [showConfirm, setShowConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");

  async function handleCancelSubscription() {
    setCancelling(true);
    setCancelError("");
    try {
      const res = await fetch("/api/stripe/cancel-subscription", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setCancelledAt(new Date().toISOString());
        setShowConfirm(false);
      } else {
        setCancelError(data.error ?? "Something went wrong");
      }
    } catch {
      setCancelError("Network error — please try again");
    } finally {
      setCancelling(false);
    }
  }

  const [newPassword, setNewPassword]       = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError]   = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  async function handleSetPassword() {
    setPasswordError("");
    setPasswordSuccess(false);
    if (newPassword.length < 8) { setPasswordError("Password must be at least 8 characters"); return; }
    if (newPassword !== confirmPassword) { setPasswordError("Passwords don't match"); return; }
    setPasswordLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setPasswordSuccess(true);
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to set password");
    } finally {
      setPasswordLoading(false);
    }
  }

  const slug = (profile.slug as string) ?? "";
  const planName = plan?.name ?? (profile.plan_id ? `Plan ${profile.plan_id}` : null);
  const planId = (profile.plan_id as number | null) ?? null;
  const isFreeOrCreator = !planId || planId === 1;
  const priceLabel = fmtPrice(stripePrice.amount, stripePrice.currency, stripePrice.interval);
  const planLabel = planName && priceLabel ? `${planName} · ${priceLabel}` : planName;

  const renewDate = subscription?.current_period_end
    ? new Date(subscription.current_period_end as string).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  const subStatus = subscription?.status as string | undefined;
  const isCancelPending = subStatus === "active" && !!cancelledAt;
  const isCancelled = subStatus === "canceled" || subStatus === "cancelled";
  const showSwitchButton = (planId ?? 0) > 1 && subStatus === "active" && !cancelledAt;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 30,
        fontWeight: 800,
        color: ACCENT,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "0 0 28px",
        lineHeight: 1.1,
      }}>
        Account
      </h1>

      {/* Card 1: Username */}
      <div style={card}>
        <span style={labelStyle}>Your handle</span>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY, marginBottom: 6 }}>
          @{slug}
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, fontFamily: FONT_BODY }}>
          Read-only for now
        </p>
      </div>

      {/* Card 2: Password */}
      <div style={card}>
        <span style={labelStyle}>Set a Password</span>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", fontFamily: FONT_BODY }}>
          Set a password so you can log in without a magic link
        </p>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password"
          minLength={8}
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "var(--surface-muted)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 15,
            color: "var(--text)",
            outline: "none",
            marginBottom: 10,
            boxSizing: "border-box",
            fontFamily: FONT_BODY,
          }}
        />
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Confirm password"
          minLength={8}
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "var(--surface-muted)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 15,
            color: "var(--text)",
            outline: "none",
            marginBottom: 12,
            boxSizing: "border-box",
            fontFamily: FONT_BODY,
          }}
        />
        {passwordError && (
          <p style={{ fontSize: 13, color: "#ef4444", margin: "0 0 10px", fontFamily: FONT_BODY }}>
            {passwordError}
          </p>
        )}
        {passwordSuccess && (
          <p style={{ fontSize: 13, color: "#22c55e", margin: "0 0 10px", fontFamily: FONT_BODY }}>
            Password set successfully
          </p>
        )}
        <button
          onClick={handleSetPassword}
          disabled={passwordLoading}
          style={{
            padding: "10px 22px",
            background: ACCENT,
            color: "#fff",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: FONT_BODY,
            opacity: passwordLoading ? 0.6 : 1,
          }}
        >
          {passwordLoading ? "Saving…" : "Set Password"}
        </button>
      </div>

      {/* Card 3: Subscription */}
      <div id="subscription-card" style={card}>
        <span style={labelStyle}>Subscription</span>

        {isFreeOrCreator ? (
          /* ── Free / Creator baseline ── */
          <div>
            <span style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY, display: "block", marginBottom: 12 }}>
              SQRZ Creator — Free
            </span>
            <a
              href="?upgrade=boost"
              style={{
                display: "inline-block",
                padding: "9px 20px",
                background: ACCENT,
                color: "#111",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 700,
                textDecoration: "none",
                fontFamily: FONT_BODY,
              }}
            >
              Upgrade to Boost →
            </a>
          </div>
        ) : (
          /* ── Paid plan ── */
          <div>
            <span style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY, display: "block", marginBottom: 8 }}>
              {planLabel ?? planName}
            </span>

            {/* Cancel-pending amber warning */}
            {isCancelPending && renewDate ? (
              <div style={{ marginBottom: 12, padding: "10px 14px", background: "rgba(245,166,35,0.08)", border: "1px solid rgba(245,166,35,0.3)", borderRadius: 8 }}>
                <p style={{ fontSize: 13, color: ACCENT, margin: 0, fontFamily: FONT_BODY }}>
                  ⚠ Active until {renewDate} — will not renew
                </p>
              </div>
            ) : isCancelled ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 12px", fontFamily: FONT_BODY }}>
                Your plan has been downgraded to Creator.
              </p>
            ) : renewDate ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 12px", fontFamily: FONT_BODY }}>
                Next billing: {renewDate}
              </p>
            ) : null}

            {/* Action buttons row */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
              {showSwitchButton && (
                <button
                  onClick={() => setShowConfirm(true)}
                  style={{
                    padding: "8px 16px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 13,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontFamily: FONT_BODY,
                  }}
                >
                  Switch to Creator
                </button>
              )}
              {billingPortalUrl ? (
                <a
                  href={billingPortalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    padding: "8px 16px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text)",
                    textDecoration: "none",
                    fontFamily: FONT_BODY,
                    display: "inline-block",
                  }}
                >
                  Manage Billing →
                </a>
              ) : (
                <span
                  title="Billing portal unavailable — contact support"
                  style={{
                    padding: "8px 16px",
                    fontSize: 13,
                    color: "var(--text-muted)",
                    fontFamily: FONT_BODY,
                    opacity: 0.4,
                  }}
                >
                  Manage Billing →
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Confirm cancel dialog */}
      {showConfirm && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 20px",
        }}>
          <div style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: "28px 24px",
            maxWidth: 420,
            width: "100%",
            fontFamily: FONT_BODY,
          }}>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", margin: "0 0 10px" }}>
              Switch to Creator?
            </h3>
            <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 20px", lineHeight: 1.6 }}>
              You'll keep {planName} until {renewDate ?? "the end of your billing period"}, then move to Creator. Your profile and data stay intact.
            </p>
            {cancelError && (
              <p style={{ fontSize: 13, color: "#ef4444", margin: "0 0 12px" }}>{cancelError}</p>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={handleCancelSubscription}
                disabled={cancelling}
                style={{
                  flex: 1,
                  padding: "10px",
                  background: ACCENT,
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: cancelling ? "default" : "pointer",
                  opacity: cancelling ? 0.6 : 1,
                  fontFamily: FONT_BODY,
                }}
              >
                {cancelling ? "Processing…" : "Confirm"}
              </button>
              <button
                onClick={() => { setShowConfirm(false); setCancelError(""); }}
                disabled={cancelling}
                style={{
                  flex: 1,
                  padding: "10px",
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  fontSize: 14,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontFamily: FONT_BODY,
                }}
              >
                Keep plan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Card 4: Sign Out */}
      <div style={card}>
        <span style={labelStyle}>Session</span>
        <signOutFetcher.Form method="post">
          <input type="hidden" name="intent" value="sign_out" />
          <button
            type="submit"
            disabled={signOutFetcher.state !== "idle"}
            style={{
              padding: "10px 22px",
              background: "rgba(239,68,68,0.1)",
              color: "#ef4444",
              border: "1px solid rgba(239,68,68,0.25)",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FONT_BODY,
              display: "block",
              marginBottom: 8,
            }}
          >
            {signOutFetcher.state !== "idle" ? "Signing out…" : "Sign out →"}
          </button>
        </signOutFetcher.Form>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, fontFamily: FONT_BODY }}>
          You'll be signed out of this device.
        </p>
      </div>
    </div>
  );
}
