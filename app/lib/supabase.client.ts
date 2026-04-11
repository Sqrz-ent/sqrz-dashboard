import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client.
 * Uses createBrowserClient from @supabase/ssr which syncs the session
 * to cookies so server-side loaders can read it via createSupabaseServerClient.
 */
export const supabase = createBrowserClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
  {
    auth: {
      flowType: "implicit",
      detectSessionInUrl: true,
    },
  }
);
