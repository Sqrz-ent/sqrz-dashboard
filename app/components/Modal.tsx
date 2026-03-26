import { useEffect } from "react";

const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";
const ACCENT = "#F5A623";

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          borderRadius: 16,
          borderTop: `3px solid ${ACCENT}`,
          width: "100%",
          maxWidth: 480,
          minHeight: "60vh",
          maxHeight: "85vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "18px 22px 14px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 17,
              fontWeight: 700,
              color: "var(--text)",
              fontFamily: FONT_BODY,
            }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
              fontSize: 18,
              lineHeight: 1,
              padding: "4px 8px",
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: "20px 22px", overflowY: "auto", flex: 1, minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
