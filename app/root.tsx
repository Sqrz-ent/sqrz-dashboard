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
        <meta name="theme-color" content="#F5A623" />
        <link rel="icon" type="image/png" href="/sqrz-logo-mark.png" />
        <link rel="apple-touch-icon" href="/sqrz-logo-mark.png" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body {
                background: #fff5e8;
              }
            `,
          }}
        />
        <Meta />
        <Links />
      </head>
      <body>
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
