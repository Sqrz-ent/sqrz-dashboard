import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

function parseCookies(cookieHeader: string): Array<{ name: string; value: string }> {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const idx = c.indexOf("=");
      return { name: c.slice(0, idx).trim(), value: c.slice(idx + 1).trim() };
    });
}

function serializeCookie(
  name: string,
  value: string,
  options?: Record<string, unknown>
): string {
  const parts = [`${name}=${value}`];
  if (options?.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options?.path) parts.push(`Path=${options.path as string}`);
  if (options?.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options?.httpOnly) parts.push("HttpOnly");
  if (options?.secure) parts.push("Secure");
  if (options?.sameSite) parts.push(`SameSite=${options.sameSite as string}`);
  return parts.join("; ");
}

/**
 * Creates a session-aware Supabase server client that reads/writes cookies.
 * Returns { supabase, headers } — callers must forward headers on all responses.
 */
export function createSupabaseServerClient(request: Request) {
  const headers = new Headers();
  const supabase = createServerClient(
    import.meta.env.VITE_SUPABASE_URL as string,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
    {
      cookies: {
        getAll() {
          return parseCookies(request.headers.get("Cookie") ?? "");
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            headers.append(
              "Set-Cookie",
              serializeCookie(name, value, options as Record<string, unknown>)
            );
          });
        },
      },
    }
  );
  return { supabase, headers };
}

/**
 * Admin client using the service role key — bypasses RLS.
 * Only use server-side for trusted operations.
 */
export function createSupabaseAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient(import.meta.env.VITE_SUPABASE_URL as string, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
