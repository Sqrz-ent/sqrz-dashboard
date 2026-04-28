import { useState } from "react";
import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.office.partner-onboarding";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

const ACCENT = "#F5A623";
const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  padding: "28px 28px",
  marginBottom: 20,
};

const infoCard: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "16px 18px",
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const inviteStatus = profile.partner_invite_status as string | null;
  if (inviteStatus !== "invited") return redirect("/office", { headers });

  return Response.json(
    { profileId: profile.id as string },
    { headers }
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "accept") {
    await supabase
      .from("profiles")
      .update({
        is_partner: true,
        partner_invite_status: "accepted",
        partner_tos_accepted_at: new Date().toISOString(),
      })
      .eq("id", profile.id as string);

    return redirect("/office/partners", { headers });
  }

  if (intent === "decline") {
    await supabase
      .from("profiles")
      .update({ partner_invite_status: "declined" })
      .eq("id", profile.id as string);

    return redirect("/office", { headers });
  }

  return redirect("/office", { headers });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PartnerOnboarding() {
  useLoaderData<typeof loader>();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [tosChecked, setTosChecked] = useState(false);

  return (
    <div
      style={{
        maxWidth: 600,
        margin: "0 auto",
        padding: "40px 20px 100px",
        fontFamily: FONT_BODY,
        color: "var(--text)",
      }}
    >
      {/* Step indicator */}
      <div style={{ display: "flex", gap: 8, marginBottom: 32, alignItems: "center" }}>
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            style={{
              width: s === step ? 24 : 8,
              height: 8,
              borderRadius: 4,
              background: s === step ? ACCENT : s < step ? "rgba(245,166,35,0.4)" : "var(--border)",
              transition: "all 0.2s",
            }}
          />
        ))}
      </div>

      {/* ── Step 1 — The invitation ─────────────────────────────────────────── */}
      {step === 1 && (
        <div style={card}>
          <div style={{ fontSize: 28, marginBottom: 16 }}>✦</div>
          <h1
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 32,
              fontWeight: 800,
              color: ACCENT,
              textTransform: "uppercase",
              letterSpacing: "0.03em",
              margin: "0 0 16px",
              lineHeight: 1.1,
            }}
          >
            You&apos;ve been chosen
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: "var(--text)", margin: "0 0 12px" }}>
            Will Villa has personally invited you to join the SQRZ Partner Program.
          </p>
          <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-muted)", margin: 0 }}>
            This is an exclusive, invite-only program for independent creatives who believe in the
            platform and want to grow with it.
          </p>

          <button
            type="button"
            onClick={() => setStep(2)}
            style={{
              marginTop: 28,
              padding: "12px 28px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FONT_BODY,
            }}
          >
            Next →
          </button>
        </div>
      )}

      {/* ── Step 2 — How it works ──────────────────────────────────────────── */}
      {step === 2 && (
        <div style={card}>
          <h2
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 26,
              fontWeight: 800,
              color: "var(--text)",
              textTransform: "uppercase",
              letterSpacing: "0.03em",
              margin: "0 0 20px",
            }}
          >
            How it works
          </h2>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={infoCard}>
              <div style={{ fontSize: 20, marginBottom: 8 }}>💰</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                Earn 30% commission
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                On every subscription you refer, for 12 months. Tiers: 30% → 40% → 50% as you grow.
              </div>
            </div>

            <div style={infoCard}>
              <div style={{ fontSize: 20, marginBottom: 8 }}>🔗</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                Your referral link
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                Share <code style={{ background: "var(--surface-muted)", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>sqrz.com?ref=yourslug</code> with anyone. They sign up → you earn.
              </div>
            </div>

            <div style={infoCard}>
              <div style={{ fontSize: 20, marginBottom: 8 }}>📅</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                Booking commissions
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                Refer creatives with Stripe Connect into bookings. Earn 2.5% of every completed
                booking value.
              </div>
            </div>

            <div style={infoCard}>
              <div style={{ fontSize: 20, marginBottom: 8 }}>💸</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                Monthly payouts
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                Earnings above €25 paid out monthly via Stripe Connect to your bank account.
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
            <button
              type="button"
              onClick={() => setStep(1)}
              style={{
                padding: "12px 20px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              style={{
                flex: 1,
                padding: "12px 20px",
                background: ACCENT,
                color: "#111",
                border: "none",
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3 — Terms & accept ─────────────────────────────────────────── */}
      {step === 3 && (
        <div style={card}>
          <h2
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 26,
              fontWeight: 800,
              color: "var(--text)",
              textTransform: "uppercase",
              letterSpacing: "0.03em",
              margin: "0 0 4px",
            }}
          >
            Partner Program Terms
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 20px", lineHeight: 1.5 }}>
            Please read before accepting.
          </p>

          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "16px 18px",
              marginBottom: 20,
              fontSize: 13,
              color: "var(--text-muted)",
              lineHeight: 1.9,
            }}
          >
            <p style={{ margin: "0 0 8px", color: "var(--text)", fontWeight: 600, fontSize: 14 }}>
              By joining the SQRZ Partner Program you agree to:
            </p>
            <ul style={{ margin: 0, padding: "0 0 0 18px" }}>
              <li>
                Commissions are earned on gross subscription revenue and completed bookings
                processed through SQRZ.
              </li>
              <li>
                Commission window is 12 months from a referred user&apos;s first payment.
              </li>
              <li>Payouts are processed monthly for balances above €25.</li>
              <li>
                SQRZ reserves the right to pause or revoke partner status for abuse or violation of
                platform terms.
              </li>
              <li>
                Booking referral commissions (2.5%) apply only when the referred profile has active
                Stripe Connect.
              </li>
              <li>You may not refer yourself or create fraudulent accounts.</li>
            </ul>
            <p style={{ margin: "12px 0 0" }}>
              <a
                href="https://sqrz.com/terms"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: ACCENT, textDecoration: "none", fontWeight: 600 }}
              >
                Full Terms of Service → sqrz.com/terms
              </a>
            </p>
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              cursor: "pointer",
              marginBottom: 24,
            }}
          >
            <input
              type="checkbox"
              checked={tosChecked}
              onChange={(e) => setTosChecked(e.target.checked)}
              style={{ marginTop: 2, accentColor: ACCENT, width: 16, height: 16, flexShrink: 0 }}
            />
            <span style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>
              I have read and agree to the Partner Program Terms
            </span>
          </label>

          {/* Accept form */}
          <form method="post">
            <input type="hidden" name="intent" value="accept" />
            <button
              type="submit"
              disabled={!tosChecked}
              style={{
                width: "100%",
                padding: "13px",
                background: tosChecked ? ACCENT : "var(--surface-muted)",
                color: tosChecked ? "#111" : "var(--text-muted)",
                border: "none",
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 700,
                cursor: tosChecked ? "pointer" : "not-allowed",
                fontFamily: FONT_BODY,
                marginBottom: 12,
                transition: "background 0.15s",
              }}
            >
              Activate my partnership →
            </button>
          </form>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setStep(2)}
              style={{
                padding: "10px 18px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              ← Back
            </button>

            {/* Decline form */}
            <form method="post" style={{ marginLeft: "auto" }}>
              <input type="hidden" name="intent" value="decline" />
              <button
                type="submit"
                style={{
                  padding: "10px 18px",
                  background: "none",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 13,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontFamily: FONT_BODY,
                  textDecoration: "underline",
                }}
              >
                Decline invitation
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
