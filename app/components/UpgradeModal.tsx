import { useEffect, useRef, useState } from "react";
import { Form } from "react-router";

type UpgradeView = "all" | "creator" | "boost" | "grow";

interface UpgradeModalProps {
  onClose: () => void;
  upgradeContext: string;
  // Creator plan
  monthlyPriceId: string;
  yearlyPriceId: string;
  referredByCode: string | null;
  earlyAccessCouponId: string;
  isClaimed: boolean;
  isPartner: boolean;
  // Boost plan
  boostMonthlyPriceId: string;
  // Grow plan
  growCampaignPriceId: string;
}

const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

const PLANS: { key: UpgradeView; name: string; price: string; bullets: string[] }[] = [
  {
    key: "creator",
    name: "Creator",
    price: "From $7/mo",
    bullets: ["Custom domain", "Pixel tracking", "Analytics"],
  },
  {
    key: "boost",
    name: "Boost",
    price: "$39/mo",
    bullets: ["Everything in Creator", "Boost campaigns", "Private links"],
  },
  {
    key: "grow",
    name: "Grow",
    price: "Contact us",
    bullets: ["Everything in Boost", "Media library", "Personal access"],
  },
];

const HEADINGS: Record<UpgradeView, { title: string; subtitle: string }> = {
  all:     { title: "Choose a plan",        subtitle: "Unlock more of SQRZ as your needs grow." },
  creator: { title: "Upgrade to Creator",   subtitle: "Unlock your full profile, custom domain, and more." },
  boost:   { title: "Upgrade to Boost",     subtitle: "Run targeted campaigns and unlock private links." },
  grow:    { title: "Upgrade to Grow",      subtitle: "Unlock the full SQRZ platform including media library." },
};

function contextToView(ctx: string): UpgradeView {
  if (ctx === "creator") return "creator";
  if (ctx === "boost")   return "boost";
  if (ctx === "grow")    return "grow";
  return "all";
}

const submitBtn: React.CSSProperties = {
  width: "100%",
  padding: "10px 0",
  background: "#F5A623",
  color: "#111111",
  border: "none",
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: FONT_BODY,
};

export default function UpgradeModal({
  onClose,
  upgradeContext,
  monthlyPriceId,
  yearlyPriceId,
  referredByCode,
  earlyAccessCouponId,
  isClaimed,
  isPartner,
  boostMonthlyPriceId,
  growCampaignPriceId,
}: UpgradeModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<UpgradeView>(contextToView(upgradeContext));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.width = "";
    };
  }, []);

  const { title, subtitle } = HEADINGS[view];

  return (
    <>
      {/* Overlay — flex container handles mobile bottom-sheet vs desktop center */}
      <div
        className="upgrade-modal-overlay"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 50,
          display: "flex",
          justifyContent: "center",
        }}
      >
        {/* Backdrop */}
        <div
          onClick={onClose}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
            animation: "upgradeModalFadeIn 0.18s ease",
          }}
        />

        {/* Modal */}
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Upgrade your plan"
          className="upgrade-modal"
          style={{
            position: "relative",
            width: view === "all" ? "min(680px, 100%)" : "min(480px, 100%)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
            zIndex: 1,
            padding: "28px 28px 24px",
            fontFamily: FONT_BODY,
          }}
        >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: view !== "all" ? 6 : 4 }}>
          <div style={{ flex: 1 }}>
            {view !== "all" && (
              <button
                onClick={() => setView("all")}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: "0 0 8px",
                  fontFamily: FONT_BODY,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                ← All plans
              </button>
            )}
            <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: 0 }}>
              {title}
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "6px 0 0" }}>
              {subtitle}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 22,
              cursor: "pointer",
              lineHeight: 1,
              padding: 0,
              marginTop: -2,
              marginLeft: 12,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* ── All Plans ── */}
        {view === "all" && (
          <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
            {PLANS.map((plan) => (
              <div
                key={plan.key}
                style={{
                  flex: "1 1 160px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  padding: "18px 16px",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 6px" }}>
                  {plan.name}
                </p>
                <p style={{ color: "var(--text)", fontSize: 20, fontWeight: 800, margin: "0 0 12px" }}>
                  {plan.price}
                </p>
                <ul style={{ margin: "0 0 16px", padding: "0 0 0 14px", flex: 1 }}>
                  {plan.bullets.map((b) => (
                    <li key={b} style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.7 }}>{b}</li>
                  ))}
                </ul>
                <button
                  onClick={() => setView(plan.key)}
                  style={submitBtn}
                >
                  Select →
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Creator plan ── */}
        {view === "creator" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 22 }}>
            {/* Monthly */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "18px 16px" }}>
              <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>
                Monthly
              </p>
              <p style={{ color: "var(--text)", fontSize: 26, fontWeight: 800, margin: "0 0 2px" }}>
                $12<span style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 400 }}>/mo</span>
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 16px" }}>Billed monthly</p>
              <Form method="post" action="/api/stripe/checkout">
                <input type="hidden" name="price_id" value={monthlyPriceId} />
                <button type="submit" style={submitBtn}>Select</button>
              </Form>
            </div>

            {/* Yearly */}
            <div style={{ background: "var(--bg)", border: "1px solid rgba(245,166,35,0.4)", borderRadius: 14, padding: "18px 16px", position: "relative" }}>
              <span style={{
                position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)",
                background: "#F5A623", color: "#111111", fontSize: 10, fontWeight: 800,
                borderRadius: 20, padding: "3px 10px", whiteSpace: "nowrap",
                letterSpacing: "0.04em", textTransform: "uppercase",
              }}>
                {referredByCode ? "Your Invite" : "Save 42%"}
              </span>
              <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>
                Yearly
              </p>
              {referredByCode ? (
                <>
                  <p style={{ color: "var(--text)", fontSize: 26, fontWeight: 800, margin: "0 0 2px" }}>
                    $29<span style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 400 }}>/yr</span>
                  </p>
                  <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 16px" }}>
                    <s>$84/year</s>{" "}with your invite
                  </p>
                </>
              ) : (
                <>
                  <p style={{ color: "var(--text)", fontSize: 26, fontWeight: 800, margin: "0 0 2px" }}>
                    $7<span style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 400 }}>/mo</span>
                  </p>
                  <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 16px" }}>$84 billed yearly</p>
                </>
              )}
              <Form method="post" action="/api/stripe/checkout">
                <input type="hidden" name="price_id" value={yearlyPriceId} />
                {(isClaimed || isPartner) && earlyAccessCouponId && (
                  <input type="hidden" name="coupon_id" value={earlyAccessCouponId} />
                )}
                <button type="submit" style={submitBtn}>Select</button>
              </Form>
            </div>
          </div>
        )}

        {/* ── Boost plan ── */}
        {view === "boost" && (
          <div style={{ marginTop: 22 }}>
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "18px 16px" }}>
              <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>
                Monthly
              </p>
              <p style={{ color: "var(--text)", fontSize: 26, fontWeight: 800, margin: "0 0 2px" }}>
                $39<span style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 400 }}>/mo</span>
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 16px" }}>
                Everything in Creator · Targeted campaigns · Private links
              </p>
              <Form method="post" action="/api/stripe/checkout">
                <input type="hidden" name="price_id" value={boostMonthlyPriceId} />
                <button type="submit" style={submitBtn}>Select</button>
              </Form>
            </div>
          </div>
        )}

        {/* ── Grow plan ── */}
        {view === "grow" && (
          <div style={{ marginTop: 22 }}>
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "18px 16px" }}>
              <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>
                Per Campaign
              </p>
              <p style={{ color: "var(--text)", fontSize: 26, fontWeight: 800, margin: "0 0 2px" }}>
                Custom pricing
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 16px" }}>
                Everything in Boost · Media library · Personal access
              </p>
              <a
                href="https://meetings.hubspot.com/willvilla/sqrz-grow-discovery-call"
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "block", textAlign: "center", textDecoration: "none", boxSizing: "border-box", ...submitBtn }}
              >
                Book a call →
              </a>
            </div>
          </div>
        )}

        {view !== "grow" && (
          <p style={{ color: "var(--text-muted)", fontSize: 11, textAlign: "center", margin: "18px 0 0" }}>
            Cancel anytime · Secure checkout via Stripe
          </p>
        )}
        </div>
      </div>

      <style>{`
        @keyframes upgradeModalFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes upgradeModalSlideUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes upgradeModalSlideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .upgrade-modal-overlay {
          align-items: center;
          padding: 1.5rem;
        }
        .upgrade-modal {
          border-radius: 16px;
          max-height: 85vh;
          overflow-y: auto;
          animation: upgradeModalSlideIn 0.18s ease;
        }
      `}</style>
    </>
  );
}
