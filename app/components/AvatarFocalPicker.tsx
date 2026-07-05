"use client";

import { useEffect, useRef, useState } from "react";

const ACCENT = "#F5A623";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// Drag-to-reposition focal picker for the hero background. Shows the source image
// with a draggable crosshair and two live previews (desktop + mobile hero shapes),
// all client-side — no upload/network while dragging. onConfirm returns the
// normalized focal point (0..1). Matches the hero render: background-size cover +
// background-position {x}% {y}%.
export default function AvatarFocalPicker({
  file,
  uploading = false,
  onConfirm,
  onCancel,
}: {
  file: File;
  uploading?: boolean;
  onConfirm: (focalX: number, focalY: number) => void;
  onCancel: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string>("");
  // Default matches the current hero behavior: horizontally centered, top-aligned.
  const [focal, setFocal] = useState<{ x: number; y: number }>({ x: 0.5, y: 0 });
  const areaRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function updateFromEvent(clientX: number, clientY: number) {
    const el = areaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    setFocal({
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    updateFromEvent(e.clientX, e.clientY);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    updateFromEvent(e.clientX, e.clientY);
  }
  function endDrag() {
    dragging.current = false;
  }

  const bgPos = `${(focal.x * 100).toFixed(1)}% ${(focal.y * 100).toFixed(1)}%`;
  const previewBase: React.CSSProperties = {
    backgroundImage: objectUrl ? `url(${objectUrl})` : undefined,
    backgroundSize: "cover",
    backgroundPosition: bgPos,
    backgroundColor: "#1a1a1a",
    borderRadius: 8,
    border: "1px solid var(--border)",
  };
  const previewLabel: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    margin: "0 0 6px",
    fontFamily: FONT_BODY,
  };

  return (
    <div style={{ marginTop: 14, fontFamily: FONT_BODY }}>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px" }}>
        Drag to choose the focal point — the previews show how your hero will look.
      </p>

      {/* Source image with draggable crosshair */}
      <div
        ref={areaRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: "relative",
          width: "100%",
          maxHeight: 320,
          overflow: "hidden",
          borderRadius: 10,
          border: "1px solid var(--border)",
          cursor: "crosshair",
          touchAction: "none",
          userSelect: "none",
          background: "#1a1a1a",
        }}
      >
        {objectUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={objectUrl}
            alt="Selected photo"
            draggable={false}
            style={{ width: "100%", height: "auto", display: "block", pointerEvents: "none", maxHeight: 320, objectFit: "contain" }}
          />
        )}
        <div
          style={{
            position: "absolute",
            left: `${focal.x * 100}%`,
            top: `${focal.y * 100}%`,
            width: 30,
            height: 30,
            marginLeft: -15,
            marginTop: -15,
            borderRadius: "50%",
            border: "3px solid #fff",
            boxShadow: "0 0 0 2px rgba(0,0,0,0.45)",
            background: "rgba(245,166,35,0.35)",
            pointerEvents: "none",
          }}
        />
      </div>

      {/* Live previews — desktop (wide) + mobile (tall/narrow) hero shapes */}
      <div style={{ display: "flex", gap: 14, marginTop: 14, alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <p style={previewLabel}>Desktop</p>
          <div style={{ ...previewBase, width: "100%", aspectRatio: "5 / 2" }} />
        </div>
        <div style={{ width: 96 }}>
          <p style={previewLabel}>Mobile</p>
          <div style={{ ...previewBase, width: 96, aspectRatio: "3 / 4" }} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={uploading}
          style={{
            padding: "10px 18px",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 10,
            color: "var(--text)",
            fontSize: 13,
            fontWeight: 600,
            cursor: uploading ? "default" : "pointer",
            fontFamily: FONT_BODY,
            opacity: uploading ? 0.6 : 1,
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(Number(focal.x.toFixed(4)), Number(focal.y.toFixed(4)))}
          disabled={uploading}
          style={{
            padding: "10px 18px",
            background: ACCENT,
            border: "none",
            borderRadius: 10,
            color: "#111",
            fontSize: 13,
            fontWeight: 700,
            cursor: uploading ? "default" : "pointer",
            fontFamily: FONT_BODY,
            opacity: uploading ? 0.6 : 1,
          }}
        >
          {uploading ? "Uploading…" : "Save photo"}
        </button>
      </div>
    </div>
  );
}
