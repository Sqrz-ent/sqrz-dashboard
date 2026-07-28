// SQRZ Grow teaser — invite-only preview of the managed campaign-partner
// features (mirrors the iOS GrowTabView GROW section). No backend; the cards are
// static and each carries a "Coming soon" badge.

const ACCENT = "#F5A623";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

type Teaser = { icon: string; title: string; description: string };

const TEASERS: Teaser[] = [
  {
    icon: "✨",
    title: "Daily Campaign Digest",
    description:
      "Your AI advisor checks your campaign performance every day and tells you exactly what to do next",
  },
  {
    icon: "💡",
    title: "Daily Tips",
    description:
      "Actionable tips tailored to your profile and audience — delivered every morning",
  },
  {
    icon: "🎙️",
    title: "From the Founder",
    description:
      "Direct insights from Will Villa — what's working across campaigns right now",
  },
  {
    icon: "🖼️",
    title: "Creative Asset Upload",
    description:
      "Upload photos and videos for all campaign formats — stories, reels, banners — preview exactly how they'll look before launch",
  },
  {
    icon: "💬",
    title: "Live Campaign Support",
    description:
      "Chat directly with your campaign manager. Get feedback, approvals, and updates in real time",
  },
];

export default function GrowTeaser() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, fontFamily: FONT_BODY }}>
      {TEASERS.map((t) => (
        <div
          key={t.title}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: "16px 18px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <span style={{ fontSize: 20, width: 28, textAlign: "center", flexShrink: 0 }}>{t.icon}</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", flex: 1, minWidth: 0 }}>
              {t.title}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                color: ACCENT,
                background: "rgba(245,166,35,0.12)",
                borderRadius: 20,
                padding: "3px 9px",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              Coming soon
            </span>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            {t.description}
          </p>
        </div>
      ))}
    </div>
  );
}

// "Invite only — you're in" badge, rendered next to the GROW section header.
export function InviteOnlyBadge() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.02em",
        color: ACCENT,
        background: "rgba(245,166,35,0.12)",
        borderRadius: 20,
        padding: "4px 11px",
        whiteSpace: "nowrap",
        fontFamily: FONT_BODY,
      }}
    >
      ✓ Invite only — you're in
    </span>
  );
}
