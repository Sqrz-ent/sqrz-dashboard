import { useEffect, useState } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import {
  ThemeContext,
  parseThemeCookie,
  writeThemeCookie,
  type Theme,
} from "~/lib/theme";

// Read the theme from a first-party cookie so <html> is server-rendered with the
// correct class on first paint. This makes the theme part of React's controlled
// VDOM (identical on server + client), so a downstream hydration mismatch can no
// longer re-render the root and strip a client-injected class (the /analytics
// black-screen bug). Defaults to dark.
export function loader({ request }: Route.LoaderArgs) {
  return { theme: parseThemeCookie(request.headers.get("Cookie")) };
}

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300..700;1,9..40,300..700&family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  // Loader data is the source of truth (SSR + client agree). During a root
  // loader error it's undefined, so fall back to dark.
  const data = useRouteLoaderData<typeof loader>("root");
  const [theme, setTheme] = useState<Theme>(data?.theme ?? "dark");

  // One-time migration: the theme used to live in localStorage only. If there's
  // no cookie yet but a legacy pref exists, promote it (post-hydration, so no
  // mismatch) so SSR renders the right class on future loads.
  useEffect(() => {
    if (/(?:^|;\s*)sqrz_theme=/.test(document.cookie)) return;
    const legacy = localStorage.getItem("sqrz_theme");
    if (legacy === "light" || legacy === "dark") {
      writeThemeCookie(legacy);
      setTheme(legacy);
    }
  }, []);

  return (
    <html lang="en" className={theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#F5A623" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="SQRZ" />
        <link rel="icon" type="image/png" href="/sqrz-logo-mark.png" />
        <link rel="apple-touch-icon" href="/sqrz-logo-mark.png" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body {
                background: #fff5e8;
              }
              html[data-standalone-pwa="true"],
              html[data-standalone-pwa="true"] body {
                background: #fff5e8 !important;
              }
              #sqrz-pwa-boot {
                position: fixed;
                inset: 0;
                z-index: 9999;
                display: none;
                align-items: center;
                justify-content: center;
                background:
                  radial-gradient(circle at 50% 16%, rgba(245, 166, 35, 0.28), transparent 42%),
                  linear-gradient(180deg, #fff5e8 0%, #f7efe1 100%);
                color: #171717;
                transition: opacity 220ms ease, visibility 220ms ease;
              }
              html[data-standalone-pwa="true"] #sqrz-pwa-boot {
                display: flex;
              }
              #sqrz-pwa-boot.is-hidden {
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
              }
              #sqrz-pwa-boot-card {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 18px;
                text-align: center;
              }
              #sqrz-pwa-boot-logo {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 108px;
                height: 108px;
              }
              #sqrz-pwa-boot-logo img {
                width: 100%;
                height: 100%;
                object-fit: contain;
                display: block;
              }
              #sqrz-pwa-boot-copy {
                display: flex;
                flex-direction: column;
                gap: 10px;
              }
              #sqrz-pwa-boot-title {
                font-family: "Barlow Condensed", Impact, sans-serif;
                font-size: 34px;
                line-height: 0.9;
                letter-spacing: 0.12em;
                color: #f5a623;
              }
              #sqrz-pwa-boot-subtitle {
                font-family: "DM Sans", sans-serif;
                font-size: 16px;
                color: rgba(23, 23, 23, 0.62);
              }
              #sqrz-pwa-boot-loader {
                width: 54px;
                height: 54px;
                border-radius: 999px;
                border: 3px solid rgba(23, 23, 23, 0.12);
                border-top-color: #171717;
                animation: sqrz-pwa-spin 900ms linear infinite;
              }
              @keyframes sqrz-pwa-spin {
                to {
                  transform: rotate(360deg);
                }
              }
            `,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            // Theme class is now server-rendered on <html> (see loader), so this
            // only handles PWA standalone detection before paint.
            __html: `try{var d=document.documentElement;var s=window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches;var ios=window.navigator&&window.navigator.standalone===true;if(s||ios){d.setAttribute('data-standalone-pwa','true');}}catch(e){}`,
          }}
        />
        <Meta />
        <Links />
      </head>
      <body>
        <div id="sqrz-pwa-boot" aria-hidden="true">
          <div id="sqrz-pwa-boot-card">
            <div id="sqrz-pwa-boot-logo">
              <img src="/sqrz-logo-mark.png" alt="SQRZ" />
            </div>
            <div id="sqrz-pwa-boot-copy">
              <div id="sqrz-pwa-boot-subtitle">Loading...</div>
            </div>
            <div id="sqrz-pwa-boot-loader" />
          </div>
        </div>
        <ThemeContext.Provider value={{ theme, setTheme }}>
          {children}
        </ThemeContext.Provider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
