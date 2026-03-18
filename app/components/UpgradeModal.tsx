import { useEffect, useRef } from "react";
import { Form } from "react-router";

interface UpgradeModalProps {
  onClose: () => void;
  monthlyPriceId: string;
  yearlyPriceId: string;
}

export default function UpgradeModal({
  onClose,
  monthlyPriceId,
  yearlyPriceId,
}: UpgradeModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Escape to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.72)",
          zIndex: 50,
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
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(480px, calc(100vw - 32px))",
          background: "#1a1a1a",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 18,
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          zIndex: 51,
          padding: "28px 28px 24px",
          animation: "upgradeModalSlideIn 0.18s ease",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6 }}>
          <div>
            <h2 style={{ color: "#ffffff", fontSize: 20, fontWeight: 700, margin: 0 }}>
              Upgrade to SQRZ Basic
            </h2>
            <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, margin: "6px 0 0" }}>
              Unlock your full profile, custom domain, and more.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.3)",
              fontSize: 22,
              cursor: "pointer",
              lineHeight: 1,
              padding: 0,
              marginTop: -2,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Plan cards */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 22 }}>
          {/* Monthly */}
          <div
            style={{
              background: "#111111",
              border: "1px solid rgba(245,166,35,0.25)",
              borderRadius: 14,
              padding: "18px 16px",
            }}
          >
            <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>
              Monthly
            </p>
            <p style={{ color: "#ffffff", fontSize: 26, fontWeight: 800, margin: "0 0 2px" }}>
              $12
              <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, fontWeight: 400 }}>/mo</span>
            </p>
            <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, margin: "0 0 16px" }}>
              Billed monthly
            </p>
            <Form method="post" action="/api/stripe/checkout">
              <input type="hidden" name="price_id" value={monthlyPriceId} />
              <button
                type="submit"
                style={{
                  width: "100%",
                  padding: "10px 0",
                  background: "#F5A623",
                  color: "#111111",
                  border: "none",
                  borderRadius: 9,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Select
              </button>
            </Form>
          </div>

          {/* Yearly */}
          <div
            style={{
              background: "#111111",
              border: "1px solid rgba(245,166,35,0.4)",
              borderRadius: 14,
              padding: "18px 16px",
              position: "relative",
            }}
          >
            {/* Best value badge */}
            <span
              style={{
                position: "absolute",
                top: -10,
                left: "50%",
                transform: "translateX(-50%)",
                background: "#F5A623",
                color: "#111111",
                fontSize: 10,
                fontWeight: 800,
                borderRadius: 20,
                padding: "3px 10px",
                whiteSpace: "nowrap",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              Save 42%
            </span>
            <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>
              Yearly
            </p>
            <p style={{ color: "#ffffff", fontSize: 26, fontWeight: 800, margin: "0 0 2px" }}>
              $7
              <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, fontWeight: 400 }}>/mo</span>
            </p>
            <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, margin: "0 0 16px" }}>
              $84 billed yearly
            </p>
            <Form method="post" action="/api/stripe/checkout">
              <input type="hidden" name="price_id" value={yearlyPriceId} />
              <button
                type="submit"
                style={{
                  width: "100%",
                  padding: "10px 0",
                  background: "#F5A623",
                  color: "#111111",
                  border: "none",
                  borderRadius: 9,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Select
              </button>
            </Form>
          </div>
        </div>

        <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 11, textAlign: "center", margin: "18px 0 0" }}>
          Cancel anytime · Secure checkout via Stripe
        </p>
      </div>

      <style>{`
        @keyframes upgradeModalFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes upgradeModalSlideIn {
          from { opacity: 0; transform: translate(-50%, -48%); }
          to   { opacity: 1; transform: translate(-50%, -50%); }
        }
      `}</style>
    </>
  );
}
