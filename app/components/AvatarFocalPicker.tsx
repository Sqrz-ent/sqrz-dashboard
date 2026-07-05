"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { computeCoverTransform } from "~/lib/heroTransform";

const ACCENT = "#F5A623";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// True hero geometry (from sqrz-profiles app/page.tsx): the hero is a full-bleed
// container with a FIXED height of 480px and cover scaling. No fixed aspect ratio
// (width = viewport), but the height is always 480px, so desktop and mobile crop
// the SAME 480px band and differ only in width:
//   desktop ~1280 × 480 →  8:3   ≈ 2.667:1 (wide)
//   mobile  ~390  × 480 → 13:16  = 0.8125:1 (narrow)
// The picker window is the desktop crop; the mobile "safe zone" is the narrower
// centred slice within it (same height). For the common landscape hero photo the
// mobile crop is exactly the centre 390/1280 of the desktop crop.
const DESKTOP_RATIO = 1280 / 480; // 2.667
const MOBILE_FRACTION = 390 / 1280; // 0.3047 — mobile visible width / desktop width

const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.02;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Drag-and-zoom focal picker. Shows the desktop hero crop live (img + transform via
// the shared computeCoverTransform), with the mobile safe zone marked and its side
// bands dimmed. Dragging pans (updates focal); the slider/wheel zooms. On confirm
// it emits the normalized focal point (0..1) + zoom (>=1) — the exact same inputs
// the profile hero feeds into computeCoverTransform.
export default function AvatarFocalPicker({
  file,
  uploading = false,
  onConfirm,
  onCancel,
}: {
  file: File;
  uploading?: boolean;
  onConfirm: (focalX: number, focalY: number, zoom: number) => void;
  onCancel: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string>("");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [focal, setFocal] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const [zoom, setZoom] = useState(1);

  const windowRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; fx: number; fy: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    setFocal({ x: 0.5, y: 0.5 });
    setZoom(1);
    setNatural(null);
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useLayoutEffect(() => {
    const el = windowRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scaled image size + the focal range that still keeps the frame covered.
  const geo = useMemo(() => {
    if (!natural || !box || natural.w <= 0 || natural.h <= 0) return null;
    const baseScale = Math.max(box.w / natural.w, box.h / natural.h);
    const scale = baseScale * zoom;
    const scaledW = natural.w * scale;
    const scaledH = natural.h * scale;
    // Focal is only meaningful within [half, 1-half]; outside would show a gap.
    const halfX = box.w / (2 * scaledW);
    const halfY = box.h / (2 * scaledH);
    return {
      scaledW,
      scaledH,
      rangeX: halfX >= 0.5 ? ([0.5, 0.5] as const) : ([halfX, 1 - halfX] as const),
      rangeY: halfY >= 0.5 ? ([0.5, 0.5] as const) : ([halfY, 1 - halfY] as const),
    };
  }, [natural, box, zoom]);

  const fx = geo ? clamp(focal.x, geo.rangeX[0], geo.rangeX[1]) : focal.x;
  const fy = geo ? clamp(focal.y, geo.rangeY[0], geo.rangeY[1]) : focal.y;

  // Keep stored focal within the valid range as zoom changes.
  useEffect(() => {
    if (geo && (fx !== focal.x || fy !== focal.y)) setFocal({ x: fx, y: fy });
  }, [geo, fx, fy, focal.x, focal.y]);

  const transform =
    natural && box && geo
      ? computeCoverTransform(box.w, box.h, natural.w, natural.h, fx, fy, zoom)
      : null;

  function onPointerDown(e: React.PointerEvent) {
    if (!geo) return;
    drag.current = { px: e.clientX, py: e.clientY, fx, fy };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current || !geo) return;
    // Dragging the image right (positive dx) reveals more of its left → focal x down.
    const nx = drag.current.fx - (e.clientX - drag.current.px) / geo.scaledW;
    const ny = drag.current.fy - (e.clientY - drag.current.py) / geo.scaledH;
    setFocal({ x: clamp(nx, geo.rangeX[0], geo.rangeX[1]), y: clamp(ny, geo.rangeY[0], geo.rangeY[1]) });
  }
  function endDrag() {
    drag.current = null;
  }
  function onWheel(e: React.WheelEvent) {
    if (!geo) return;
    setZoom((z) => clamp(z - e.deltaY * 0.002, ZOOM_MIN, ZOOM_MAX));
  }

  const stripW = box ? box.w * MOBILE_FRACTION : 0;
  const bandW = box ? (box.w - stripW) / 2 : 0;
  const ready = Boolean(transform && natural && box);

  const labelChip: React.CSSProperties = {
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
    zIndex: 3,
  };

  return (
    <div style={{ marginTop: 14, fontFamily: FONT_BODY }}>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
        Drag to reposition, zoom to fill. The full frame is your desktop hero; the
        <strong> dashed centre</strong> is the mobile safe zone — keep faces inside it.
      </p>

      <div
        ref={windowRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1280 / 480",
          borderRadius: 12,
          overflow: "hidden",
          background: "#0e0e0e",
          border: "1px solid var(--border)",
          touchAction: "none",
          userSelect: "none",
          cursor: ready ? "grab" : "default",
        }}
      >
        {objectUrl && transform && natural && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={objectUrl}
            alt="Selected photo"
            draggable={false}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: natural.w,
              height: natural.h,
              maxWidth: "none",
              transformOrigin: "top left",
              transform: `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`,
              pointerEvents: "none",
              display: "block",
            }}
          />
        )}

        {ready && (
          <>
            {/* Dim the side bands cropped out on mobile */}
            <div style={{ position: "absolute", top: 0, left: 0, width: bandW, height: "100%", background: "rgba(0,0,0,0.45)", pointerEvents: "none", zIndex: 2 }} />
            <div style={{ position: "absolute", top: 0, right: 0, width: bandW, height: "100%", background: "rgba(0,0,0,0.45)", pointerEvents: "none", zIndex: 2 }} />
            {/* Mobile safe-zone frame */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: bandW,
                width: stripW,
                height: "100%",
                border: `2px dashed ${ACCENT}`,
                boxSizing: "border-box",
                pointerEvents: "none",
                zIndex: 2,
              }}
            />
            <span style={{ ...labelChip, top: 6, left: 6, background: "rgba(255,255,255,0.9)", color: "#111" }}>
              Desktop
            </span>
            <span style={{ ...labelChip, bottom: 6, left: "50%", transform: "translateX(-50%)", background: ACCENT, color: "#111" }}>
              Mobile
            </span>
          </>
        )}

        {!ready && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
            Loading photo…
          </div>
        )}
      </div>

      {/* Zoom slider */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", fontFamily: FONT_BODY }}>Zoom</span>
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={zoom}
          disabled={!ready}
          onChange={(e) => setZoom(clamp(Number(e.target.value), ZOOM_MIN, ZOOM_MAX))}
          style={{ flex: 1, accentColor: ACCENT, cursor: ready ? "pointer" : "default" }}
        />
        <span style={{ fontSize: 12, color: "var(--text-muted)", width: 40, textAlign: "right", fontFamily: FONT_BODY }}>
          {zoom.toFixed(2)}×
        </span>
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
          onClick={() => onConfirm(Number(fx.toFixed(4)), Number(fy.toFixed(4)), Number(zoom.toFixed(4)))}
          disabled={uploading || !ready}
          style={{
            padding: "10px 18px",
            background: ACCENT,
            border: "none",
            borderRadius: 10,
            color: "#111",
            fontSize: 13,
            fontWeight: 700,
            cursor: uploading || !ready ? "default" : "pointer",
            fontFamily: FONT_BODY,
            opacity: uploading || !ready ? 0.6 : 1,
          }}
        >
          {uploading ? "Uploading…" : "Save photo"}
        </button>
      </div>
    </div>
  );
}
