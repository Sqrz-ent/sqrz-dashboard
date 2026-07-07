import { createContext, useContext } from "react";

export type Theme = "dark" | "light";

export const THEME_COOKIE = "sqrz_theme";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

// Default keeps type-safety for consumers rendered outside the provider (there
// shouldn't be any — the provider lives in the root Layout wrapping the app).
export const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  setTheme: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Parse the theme from a Cookie header string (server) or document.cookie (client). */
export function parseThemeCookie(cookie: string | null | undefined): Theme {
  const match = (cookie ?? "").match(/(?:^|;\s*)sqrz_theme=(dark|light)/);
  return match?.[1] === "light" ? "light" : "dark";
}

/** Persist the theme choice to a first-party cookie so SSR renders it on the next load. */
export function writeThemeCookie(theme: Theme): void {
  // 1 year; Lax is fine — this is a non-sensitive UI preference.
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; SameSite=Lax`;
}
