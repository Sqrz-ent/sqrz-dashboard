const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

export default function UpgradeBanner({
  planName,
  onUpgradeClick,
}: {
  planName: string;
  onUpgradeClick: () => void;
}) {
  return (
    <div
      onClick={onUpgradeClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderLeft: "3px solid var(--accent, #F5A623)",
        borderRadius: 10,
        padding: "14px 18px",
        marginBottom: 20,
        cursor: "pointer",
        fontFamily: FONT_BODY,
      }}
    >
      <span style={{ fontSize: 20, flexShrink: 0, lineHeight: 1 }}>🔒</span>
      <div>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)", lineHeight: 1.4 }}>
          This feature requires the {planName}
        </p>
        <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--accent, #F5A623)", fontWeight: 600, lineHeight: 1 }}>
          Upgrade now →
        </p>
      </div>
    </div>
  );
}
