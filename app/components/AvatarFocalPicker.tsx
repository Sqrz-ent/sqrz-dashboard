"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const ACCENT = "#F5A623";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// True hero geometry (from sqrz-profiles app/page.tsx): the hero is a full-bleed
// container with a FIXED height of 480px and background-size:cover. There is no
// fixed aspect ratio — its width is 100% of the viewport — but the height is
// always 480px on every device. So desktop and mobile crop the SAME vertical
// 480px band and differ only in width. Representative widths:
//   desktop ~1280 × 480  →  8:3   ≈ 2.667:1  (wide)
//   mobile  ~390  × 480  →  13:16 = 0.8125:1 (narrow)
// Both frames therefore share the same height; the mobile frame is a narrow,
// horizontally-centered slice nested inside the wider desktop band.
const DESKTOP_RATIO = 1280 / 480; // 2.667
const MOBILE_RATIO = 390 / 480; //   0.8125

const WINDOW_HEIGHT = 340;
const FRAME_FIT = 0.9; // outer frame occupies 90% of the fitted image

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Single-window focal picker: the full uploaded image is shown scaled to fit,
// with two fixed nested crop frames on top (outer = desktop hero, inner = mobile
// hero). The user drags the IMAGE under the fixed frames; everything outside the
// outer frame is dimmed. On confirm we emit the normalized focal point (0..1) —
// the image point sitting at the centre of the frames — which the hero render
// feeds straight into background-position: {x}% {y}%.
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
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [winW, setWinW] = useState(0);
  // Offset (px) of the image from its centred position. (0,0) => focal 50%/50%.
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const windowRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    setOffset({ x: 0, y: 0 });
    setNatural(null);
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useLayoutEffect(() => {
    function measure() {
      if (windowRef.current) setWinW(windowRef.current.clientWidth);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Scale-dependent geometry (independent of the drag offset).
  const base = useMemo(() => {
    if (!natural || winW <= 0) return null;
    const WW = winW;
    const WH = WINDOW_HEIGHT;
    // Scale the image to fit inside the window (contain) — whole image visible.
    const s = Math.min(WW / natural.w, WH / natural.h);
    const dw = natural.w * s;
    const dh = natural.h * s;
    // Largest desktop-ratio rect that fits within FRAME_FIT of the image display.
    const oh = Math.min(dh, dw / DESKTOP_RATIO) * FRAME_FIT;
    const ow = oh * DESKTOP_RATIO;
    const iw = oh * MOBILE_RATIO; // mobile shares the desktop height
    // Drag bounds keep the outer frame fully within the image (no empty crop).
    const maxOx = Math.max(0, (dw - ow) / 2);
    const maxOy = Math.max(0, (dh - oh) / 2);
    return { WW, WH, dw, dh, ow, oh, iw, maxOx, maxOy };
  }, [natural, winW]);

  function onPointerDown(e: React.PointerEvent) {
    if (!base) return;
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current || !base) return;
    setOffset({
      x: clamp(drag.current.ox + (e.clientX - drag.current.px), -base.maxOx, base.maxOx),
      y: clamp(drag.current.oy + (e.clientY - drag.current.py), -base.maxOy, base.maxOy),
    });
  }
  function endDrag() {
    drag.current = null;
  }

  // Offset-dependent geometry.
  const ox = base ? clamp(offset.x, -base.maxOx, base.maxOx) : 0;
  const oy = base ? clamp(offset.y, -base.maxOy, base.maxOy) : 0;
  const ix = base ? (base.WW - base.dw) / 2 + ox : 0;
  const iy = base ? (base.WH - base.dh) / 2 + oy : 0;
  const focalX = base ? clamp01(0.5 - ox / base.dw) : 0.5;
  const focalY = base ? clamp01(0.5 - oy / base.dh) : 0.5;

  const frameLabel: React.CSSProperties = {
    position: "absolute",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    padding: "2px 6px",
    borderRadius: 4,
    pointerEvents: "none",
    fontFamily: FONT_BODY,
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ marginTop: 14, fontFamily: FONT_BODY }}>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
        Drag the photo to frame it. The <strong>solid</strong> frame is your desktop hero,
        the <strong>dashed</strong> frame is mobile — keep what matters inside both.
      </p>

      <div
        ref={windowRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: "relative",
          width: "100%",
          height: WINDOW_HEIGHT,
          borderRadius: 12,
          overflow: "hidden",
          background: "#0e0e0e",
          border: "1px solid var(--border)",
          touchAction: "none",
          userSelect: "none",
          cursor: base ? "grab" : "default",
        }}
      >
        {objectUrl && base && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={objectUrl}
            alt="Selected photo"
            draggable={false}
            style={{
              position: "absolute",
              left: ix,
              top: iy,
              width: base.dw,
              height: base.dh,
              maxWidth: "none",
              display: "block",
              pointerEvents: "none",
            }}
          />
        )}

        {base && (
          <>
            {/* Outer (desktop) frame — box-shadow dims everything outside it */}
            <div
              style={{
                position: "absolute",
                left: (base.WW - base.ow) / 2,
                top: (base.WH - base.oh) / 2,
                width: base.ow,
                height: base.oh,
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                border: "2px solid rgba(255,255,255,0.9)",
                borderRadius: 4,
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  ...frameLabel,
                  top: -22,
                  left: 0,
                  background: "rgba(255,255,255,0.9)",
                  color: "#111",
                }}
              >
                Desktop
              </span>
            </div>

            {/* Inner (mobile) frame — nested, same height, horizontally centred */}
            <div
              style={{
                position: "absolute",
                left: (base.WW - base.iw) / 2,
                top: (base.WH - base.oh) / 2,
                width: base.iw,
                height: base.oh,
                border: `2px dashed ${ACCENT}`,
                borderRadius: 2,
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  ...frameLabel,
                  bottom: -22,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: ACCENT,
                  color: "#111",
                }}
              >
                Mobile
              </span>
            </div>
          </>
        )}

        {!base && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            Loading photo…
          </div>
        )}
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
          onClick={() => onConfirm(Number(focalX.toFixed(4)), Number(focalY.toFixed(4)))}
          disabled={uploading || !base}
          style={{
            padding: "10px 18px",
            background: ACCENT,
            border: "none",
            borderRadius: 10,
            color: "#111",
            fontSize: 13,
            fontWeight: 700,
            cursor: uploading || !base ? "default" : "pointer",
            fontFamily: FONT_BODY,
            opacity: uploading || !base ? 0.6 : 1,
          }}
        >
          {uploading ? "Uploading…" : "Save photo"}
        </button>
      </div>
    </div>
  );
}
