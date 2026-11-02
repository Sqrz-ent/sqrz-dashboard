import { useEffect, useRef, useState } from "react";
import { useLocation, useRevalidator, useSearchParams } from "react-router";
import WireTopupPanel, { type WireBank, type WireOptions, type WireTransferRow } from "~/components/WireTopupPanel";

// Header profile switcher + account balance + wallet top-up (web counterpart of
// sqrz-ios's ProfileSwitcherSheet / WalletTopupCard, 2026-11).
//
// - Profiles: every profile the signed-in login owns, oldest first, checkmark on
//   the active one. Selecting one POSTs to /api/active-profile (sets the
//   preference cookie, verified server-side) and reloads the same page. There is
//   deliberately NO "add profile" here — profiles are created in the iOS app.
// - Balance: the ACCOUNT-level wallet (account_wallets.balance_cents), shared by
//   every profile, formatted as USD like iOS (NumberFormatter .currency / USD).
// - Top up: same rules as iOS and /api/wallet/topup — $50 minimum, $5,000 maximum,
//   a flat 7% SQRZ fee added on top (shown as a breakdown), checkout on Stripe.
//   No payment logic lives here: it POSTs the amount to the existing route and
//   redirects to the Stripe Checkout URL it returns.
// - Bank transfer (2026-11): when app_config.wire_topup_enabled is on (and a bank account is set up),
//   the popover offers a second option, "Bank transfer — no card fees", with a "Save $X" badge — see
//   WireTopupPanel + docs/wallet/wire-topup.md. The amount field is shared by both options.
//   "Show bank details" only requests a non-committal quote (nothing written); the transfer itself is
//   only created once the user explicitly confirms ("I'll send this transfer"), and a pending one can
//   still be cancelled from the list afterward — all of that flow/state lives in WireTopupPanel, not here.

export type SwitcherProfile = {
  id: string;
  slug: string;
  name: string | null;
  brand_name: string | null;
  avatar_url: string | null;
};

const ACCENT = "#F5A623";

// Same display priority as iOS Profile.displayName: brand_name → name → slug.
export function profileDisplayName(p: SwitcherProfile): string {
  return (p.brand_name?.trim() || p.name?.trim() || p.slug) as string;
}

// Mirrors WalletTopupCard (iOS): bounds are convenience only; the route enforces its own.
const MIN_TOPUP_CENTS = 5_000; // $50
const MAX_TOPUP_CENTS = 500_000; // $5,000 (raised from $500 on 2026-11-02)
const TOPUP_FEE_PCT = 0.07; // matches walletTopupFeeCents in walletPayments.server.ts

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function parseTopupCents(input: string): number | null {
  const dollars = Number(input.replace(/,/g, ".").trim());
  if (!input.trim() || !Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  return cents >= MIN_TOPUP_CENTS && cents <= MAX_TOPUP_CENTS ? cents : null;
}

// Amount in cents with no bounds applied (bank transfers have their own, server-configured bounds).
function parseCents(input: string): number | null {
  const dollars = Number(input.replace(/,/g, ".").trim());
  if (!input.trim() || !Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

function topupValidationMessage(input: string): string | null {
  const dollars = Number(input.replace(/,/g, ".").trim());
  if (!input.trim() || !Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  if (cents < MIN_TOPUP_CENTS) return "Minimum top-up is $50.";
  if (cents > MAX_TOPUP_CENTS) return "Maximum top-up is $5,000.";
  return null;
}

function Avatar({ profile, size }: { profile: SwitcherProfile | undefined; size: number }) {
  const name = profile ? profileDisplayName(profile) : "?";
  if (profile?.avatar_url) {
    return (
      <img
        src={profile.avatar_url}
        alt=""
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, display: "block" }}
      />
    );
  }
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--surface-muted)",
        color: ACCENT,
        fontSize: Math.round(size * 0.42),
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const popoverStyle: React.CSSProperties = {
  // fixed, not absolute: the top nav scrolls horizontally (overflow-x:auto), which
  // would clip an absolutely-positioned child.
  position: "fixed",
  top: 60,
  right: 12,
  width: "min(340px, calc(100vw - 24px))",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
  zIndex: 200,
  padding: 8,
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
};

export default function ProfileSwitcher({
  profiles,
  activeProfileId,
  balanceCents,
}: {
  profiles: SwitcherProfile[];
  activeProfileId: string;
  balanceCents: number;
}) {
  const location = useLocation();
  const [open, setOpen] = useState<"profiles" | "topup" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [method, setMethod] = useState<"card" | "bank">("card");
  const [wire, setWire] = useState<{ options: WireOptions; transfers: WireTransferRow[]; banks: WireBank[] } | null>(null);

  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Bank-transfer availability + the account's recent transfers; loaded once when the popover opens
  // (and refreshed after a transfer is created). A failure just leaves the bank option hidden.
  function loadWire() {
    fetch("/api/wire-topup", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setWire(d))
      .catch(() => {});
  }
  useEffect(() => {
    if (open === "topup" && wire === null) loadWire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const wireEnabled = !!wire?.options?.enabled && (wire?.options.currencies.length ?? 0) > 0;
  const bankCents = parseCents(amount);
  const wireSaving =
    wireEnabled && bankCents != null && bankCents >= wire!.options.min_cents && bankCents <= wire!.options.max_cents
      ? Math.max(0, Math.round(bankCents * (wire!.options.card_fee_pct / 100)) - Math.round(bankCents * (wire!.options.fee_pct / 100)))
      : 0;

  const cents = parseTopupCents(amount);
  const fee = cents != null ? Math.round(cents * TOPUP_FEE_PCT) : 0;
  const validation = topupValidationMessage(amount);

  async function startTopup() {
    if (cents == null || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/wallet/topup?profile_id=${encodeURIComponent(activeProfileId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: cents, source: "web" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.checkout_url) {
        throw new Error(data?.error ?? "Couldn't start checkout. Please try again.");
      }
      window.location.href = data.checkout_url as string; // leave to Stripe; keep submitting=true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start checkout. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div ref={rootRef} style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
      {/* Balance + Top up */}
      <span
        title="Ad-spend wallet balance — shared across all your profiles"
        style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap" }}
      >
        {formatCents(balanceCents)}
      </span>
      <button
        type="button"
        onClick={() => setOpen(open === "topup" ? null : "topup")}
        style={{
          background: ACCENT,
          color: "#111",
          border: "none",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          padding: "6px 12px",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Top up
      </button>

      {/* Active profile */}
      <button
        type="button"
        onClick={() => setOpen(open === "profiles" ? null : "profiles")}
        aria-haspopup="menu"
        aria-expanded={open === "profiles"}
        aria-label="Switch profile"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 999,
          padding: "3px 10px 3px 3px",
          cursor: "pointer",
          color: "var(--text)",
          maxWidth: 200,
        }}
      >
        <Avatar profile={active} size={28} />
        <span
          className="hidden sm:inline"
          style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {active ? profileDisplayName(active) : ""}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>▾</span>
      </button>

      {open === "profiles" && (
        <div role="menu" style={popoverStyle}>
          <p style={{ margin: "6px 8px 8px", fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Switch profile
          </p>
          {profiles.map((p) => {
            const isActive = p.id === activeProfileId;
            return (
              <form key={p.id} method="post" action="/api/active-profile">
                <input type="hidden" name="profile_id" value={p.id} />
                <input type="hidden" name="redirect_to" value={location.pathname + location.search} />
                <button
                  type="submit"
                  role="menuitem"
                  disabled={isActive}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    textAlign: "left",
                    background: isActive ? "var(--surface-muted)" : "transparent",
                    border: "none",
                    borderRadius: 10,
                    padding: "8px",
                    cursor: isActive ? "default" : "pointer",
                    color: "var(--text)",
                  }}
                >
                  <Avatar profile={p} size={40} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {profileDisplayName(p)}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.slug}.sqrz.com
                    </span>
                  </span>
                  {isActive && <span style={{ color: ACCENT, fontWeight: 700 }}>✓</span>}
                </button>
              </form>
            );
          })}
          <p style={{ margin: "8px 8px 4px", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>
            New profiles are created in the SQRZ iOS app.
          </p>
        </div>
      )}

      {open === "topup" && (
        <div style={{ ...popoverStyle, padding: 16, maxHeight: "calc(100vh - 80px)", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
            <span style={{ fontSize: 24, fontWeight: 800, color: "var(--text)" }}>{formatCents(balanceCents)}</span>
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-muted)" }}>Shared across all your profiles</p>

          <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Top up
          </p>
          {wireEnabled && (
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {([
                ["card", "Card"],
                ["bank", "Bank transfer — no card fees"],
              ] as const).map(([key, text]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMethod(key)}
                  style={{
                    flex: key === "bank" ? 2 : 1,
                    padding: "7px 8px",
                    borderRadius: 8,
                    border: `1px solid ${method === key ? ACCENT : "var(--border)"}`,
                    background: method === key ? "rgba(245,166,35,0.12)" : "transparent",
                    color: "var(--text)",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    lineHeight: 1.25,
                  }}
                >
                  {text}
                  {key === "bank" && wireSaving > 0 && (
                    <span style={{ display: "block", color: "#22c55e", fontSize: 11 }}>Save {formatCents(wireSaving)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "10px 12px",
              marginBottom: 12,
            }}
          >
            <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>$</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startTopup()}
              inputMode="decimal"
              placeholder="Amount (e.g. 250)"
              autoFocus
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: 16, minWidth: 0 }}
            />
          </div>

          {method === "bank" && wireEnabled && wire ? (
            <WireTopupPanel
              options={wire.options}
              banks={wire.banks}
              transfers={wire.transfers}
              amountCents={bankCents}
              profileId={activeProfileId}
              onCreated={loadWire}
            />
          ) : (
            <>
          {cents != null && (
            <div style={{ marginBottom: 12, fontSize: 12, color: "var(--text-muted)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span>Ad budget</span>
                <span>{formatCents(cents)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span>SQRZ fee (7%)</span>
                <span>{formatCents(fee)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid var(--border)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                <span>Total charged</span>
                <span>{formatCents(cents + fee)}</span>
              </div>
            </div>
          )}

          <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>
            Minimum $50, maximum $5,000. A 7% SQRZ fee is added on top of your ad budget. Checkout opens in a secure Stripe page.
          </p>

          {(validation || error) && (
            <p role="alert" style={{ margin: "0 0 12px", fontSize: 12, color: "#ef4444" }}>
              {validation ?? error}
            </p>
          )}

          <button
            type="button"
            onClick={startTopup}
            disabled={cents == null || submitting}
            style={{
              width: "100%",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              padding: "12px",
              fontSize: 14,
              fontWeight: 700,
              cursor: cents == null || submitting ? "default" : "pointer",
              opacity: cents == null || submitting ? 0.5 : 1,
            }}
          >
            {submitting ? "Opening Stripe…" : "Top up via Stripe →"}
          </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Shown on return from Stripe Checkout (?wallet_topup=success|cancelled). The
// wallet is credited by the Stripe webhook, which can land a moment after the
// redirect — so on success this re-fetches the layout data a few times until the
// balance moves, instead of showing a stale number.
export function TopupReturnNotice({ balanceCents }: { balanceCents: number }) {
  const [params, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const status = params.get("wallet_topup");
  const startBalance = useRef(balanceCents);
  const attempts = useRef(0);

  useEffect(() => {
    if (status !== "success") return;
    if (balanceCents !== startBalance.current) return; // credited — stop polling
    if (attempts.current >= 8) return;
    const t = setTimeout(() => {
      attempts.current += 1;
      revalidator.revalidate();
    }, 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, balanceCents, revalidator.state]);

  if (status !== "success" && status !== "cancelled") return null;

  const credited = status === "success" && balanceCents !== startBalance.current;
  const text =
    status === "cancelled"
      ? "Top-up cancelled — you weren't charged."
      : credited
        ? `Payment received — your balance is now ${formatCents(balanceCents)}.`
        : "Payment received — updating your balance…";

  function dismiss() {
    const next = new URLSearchParams(params);
    next.delete("wallet_topup");
    setParams(next, { replace: true });
  }

  return (
    <div
      role="status"
      style={{
        background: status === "cancelled" ? "var(--surface-muted)" : "rgba(34,197,94,0.12)",
        borderBottom: "1px solid var(--border)",
        padding: "10px 20px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 13,
        color: "var(--text)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}
      >
        ✕
      </button>
    </div>
  );
}
