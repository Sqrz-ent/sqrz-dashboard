import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});

const isStandalonePwa =
  window.matchMedia?.("(display-mode: standalone)")?.matches ||
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

const bootStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();

function hideBootSplash() {
  const splash = document.getElementById("sqrz-pwa-boot");

  if (!splash || splash.classList.contains("is-hidden")) return;

  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const minimumVisibleMs = isStandalonePwa ? 900 : 300;
  const remaining = Math.max(0, minimumVisibleMs - (now - bootStartedAt));

  window.setTimeout(() => {
    splash.classList.add("is-hidden");
    window.setTimeout(() => splash.remove(), 260);
  }, remaining);
}

if (document.readyState === "complete") {
  hideBootSplash();
} else {
  window.addEventListener("load", hideBootSplash, { once: true });
  window.setTimeout(hideBootSplash, 2200);
}
