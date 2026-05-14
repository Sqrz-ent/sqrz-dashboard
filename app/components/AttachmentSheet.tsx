// Bottom sheet for attaching files to a booking chat message.
// Current MVP supports images only; the structure leaves room for richer files later.
// Rendered via React Portal on document.body.

import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";

interface AttachmentSheetProps {
  onFile: (file: File) => void;
  onClose: () => void;
  fontFamily: string;
}

export default function AttachmentSheet({ onFile, onClose, fontFamily }: AttachmentSheetProps) {
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Close on ESC
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset input so the same file can be re-selected after an error
    e.target.value = "";
    if (file) {
      onFile(file);
      onClose();
    }
  }

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2147483646,
          background: "rgba(0,0,0,0.45)",
        }}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add attachment"
        style={{
          position: "fixed",
          bottom: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(100%, 460px)",
          zIndex: 2147483647,
          background: "var(--surface)",
          borderRadius: "20px 20px 0 0",
          padding: "8px 0 max(18px, env(safe-area-inset-bottom))",
          fontFamily,
          boxShadow: "0 -8px 40px rgba(0,0,0,0.4)",
        }}
      >
        {/* Drag handle */}
        <div
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            background: "var(--border)",
            margin: "0 auto 14px",
          }}
        />

        <div style={{ padding: "0 20px 8px" }}>
          <p
            style={{
              fontSize: 12,
              fontWeight: 800,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              margin: "0 0 4px",
            }}
          >
            Add attachment
          </p>
        </div>

        {/* Choose from library */}
        <button
          onClick={() => libraryInputRef.current?.click()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            width: "100%",
            padding: "11px 20px",
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: "var(--surface-muted)",
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 17,
              flexShrink: 0,
            }}
          >
            🖼️
          </span>
          <span style={{ fontSize: 15, color: "var(--text)", fontWeight: 500 }}>
            Choose from library
          </span>
        </button>

        {/* Take photo */}
        <button
          onClick={() => cameraInputRef.current?.click()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            width: "100%",
            padding: "11px 20px",
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: "var(--surface-muted)",
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 17,
              flexShrink: 0,
            }}
          >
            📷
          </span>
          <span style={{ fontSize: 15, color: "var(--text)", fontWeight: 500 }}>
            Take photo
          </span>
        </button>

        {/* Cancel */}
        <div style={{ padding: "8px 16px 0" }}>
          <button
            onClick={onClose}
            style={{
              width: "100%",
              padding: "11px",
              background: "var(--surface-muted)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              color: "var(--text-muted)",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily,
            }}
          >
            Cancel
          </button>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </>,
    document.body
  );
}
