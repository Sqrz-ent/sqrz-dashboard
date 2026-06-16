import type { Route } from "./+types/stripe-return";

// Public pass-through page hit by Stripe AccountLink return_url for the iOS native flow.
// Stripe rejects custom URL schemes (sqrz://) as a return_url, so the native onboarding
// link returns here over https. This page immediately re-opens the app via the sqrz://
// scheme, then falls back to the web payments page if the app isn't installed/registered.
// No auth required — it carries no session and reads no protected data.
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Optional, reserved for future use (e.g. branching the fallback per platform).
  const fromIos = url.searchParams.get("from") === "ios";

  const appScheme = "sqrz://stripe-return";
  const webFallback = "https://dashboard.sqrz.com/payments";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Returning to SQRZ…</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #111111; color: #f5f5f5;
  }
  .msg { font-size: 1.05rem; letter-spacing: 0.01em; opacity: 0.9; }
</style>
</head>
<body>
  <p class="msg">Returning to SQRZ…</p>
  <script>
    // data-from-ios is informational only; the redirect behaviour is identical for now.
    document.body.setAttribute("data-from-ios", ${JSON.stringify(String(fromIos))});
    // Try to hand control back to the native app immediately.
    window.location = ${JSON.stringify(appScheme)};
    // If the app didn't take over, fall back to the web payments page.
    setTimeout(function () {
      window.location = ${JSON.stringify(webFallback)};
    }, 1500);
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
