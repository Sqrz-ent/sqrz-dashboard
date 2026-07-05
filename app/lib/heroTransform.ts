// Shared hero-image transform math.
//
// ⚠️ DUPLICATED VERBATIM in sqrz-profiles/lib/heroTransform.ts — these two repos
// are separate codebases, so the copies must be kept byte-for-byte in sync. The
// picker (sqrz-dashboard) and the hero render (sqrz-profiles) both call this so
// the crop the artist sees can never drift from the crop the visitor sees.
//
// Given a container and an image's natural pixel size, position the image so the
// focal point (focalX, focalY in 0..1 of the image) lands at the container
// centre, scaled to cover the container × zoom:
//   zoom = 1  → image scaled to exactly cover the container (baseline)
//   zoom > 1  → zoomed in further
// The translate is clamped so the image always fully covers the container (no
// gaps), regardless of focal point or zoom.
//
// Apply the result to an <img> with transform-origin: top left:
//   width:  naturalW  (px)
//   height: naturalH  (px)
//   transform: translate(${translateX}px, ${translateY}px) scale(${scale})
export function computeCoverTransform(
  containerW: number,
  containerH: number,
  naturalW: number,
  naturalH: number,
  focalX: number,
  focalY: number,
  zoom: number,
): { scale: number; translateX: number; translateY: number } {
  const safeZoom = zoom > 0 ? zoom : 1;
  const baseScale = Math.max(containerW / naturalW, containerH / naturalH);
  const scale = baseScale * safeZoom;
  const scaledW = naturalW * scale;
  const scaledH = naturalH * scale;
  let translateX = containerW / 2 - focalX * scaledW;
  let translateY = containerH / 2 - focalY * scaledH;
  // Clamp so the scaled image always covers the container (translate in [min, 0]).
  translateX = Math.min(0, Math.max(containerW - scaledW, translateX));
  translateY = Math.min(0, Math.max(containerH - scaledH, translateY));
  return { scale, translateX, translateY };
}
