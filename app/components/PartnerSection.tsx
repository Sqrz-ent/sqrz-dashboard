import { useState } from "react";
import type { BetaInviteSectionData } from "~/lib/partner.server";

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";
const ACCENT_BG = "rgba(245,166,35,0.12)";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 12,
};

const label: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 4px",
};

export type PartnerSectionProps = BetaInviteSectionData & {
  embedded?: boolean;
};

export default function PartnerSection({
  refCode,
  invites,
  stats,
  embedded = false,
}: PartnerSectionProps) {
  const [copied, setCopied] = useState(false);

  const inviteUrl = refCode ? `https://sqrz.com?ref=${refCode}` : null;

  function copyInviteLink() {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const outerStyle: React.CSSProperties = embedded
    ? { fontFamily: FONT_BODY, color: "var(--text)" }
    : { maxWidth: 760, margin: "0 auto", padding: "28px 20px 100px", fontFamily: FONT_BODY, color: "var(--text)" };

  return (
    <div style={outerStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px", color: "var(--text)" }}>
            Beta Invites
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.6 }}>
            Invite trusted people into the SQRZ iOS beta. Access is limited by the network, not by paid tiers.
          </p>
        </div>
        <span style={{ padding: "4px 12px", borderRadius: 20, background: ACCENT_BG, color: ACCENT, fontSize: 12, fontWeight: 700 }}>
          Invite Only
        </span>
      </div>

      {inviteUrl && (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <span style={{ flex: 1, color: ACCENT, fontSize: 13, fontFamily: "monospace", wordBreak: "break-all" }}>
            {inviteUrl}
          </span>
          <button
            type="button"
            onClick={copyInviteLink}
            style={{
              flexShrink: 0,
              padding: "7px 16px",
              borderRadius: 20,
              border: "none",
              background: copied ? "rgba(74,222,128,0.15)" : "var(--surface-muted)",
              color: copied ? "#4ade80" : "var(--text)",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {copied ? "Copied!" : "Copy invite"}
          </button>
        </div>
      )}

      <div className="grid grid-cols-3" style={{ gap: 12, marginBottom: 20 }}>
        <Metric label="Invites" value={stats.total} />
        <Metric label="Joined" value={stats.joined} accent />
        <Metric label="Pending" value={stats.pending} />
      </div>

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <p style={label}>Invited Profiles</p>
        </div>
        {invites.length === 0 ? (
          <div style={{ padding: "28px 16px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
            No invites used yet.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {invites.map((invite, index) => (
                <tr key={`${invite.slug}-${index}`} style={{ borderBottom: index < invites.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <td style={{ padding: "12px 16px", fontFamily: "monospace", color: "var(--text)", fontWeight: 600 }}>
                    {invite.slug}
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right" }}>
                    <span
                      style={{
                        padding: "3px 9px",
                        borderRadius: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        background: invite.status === "joined" ? "rgba(74,222,128,0.12)" : ACCENT_BG,
                        color: invite.status === "joined" ? "#4ade80" : ACCENT,
                      }}
                    >
                      {invite.status === "joined" ? "Joined" : "Pending"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Metric({ label: metricLabel, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={card}>
      <p style={label}>{metricLabel}</p>
      <p style={{ fontSize: 24, fontWeight: 800, color: accent ? ACCENT : "var(--text)", margin: 0 }}>
        {value}
      </p>
    </div>
  );
}
