import type { SupabaseClient } from "@supabase/supabase-js";

// Remote feature flags for the web dashboard, read from the existing world-readable
// app_config table (same store as purchase_gate_enabled — see pro.server.ts).
// Cached briefly in memory so page loads don't each query the table.

const TTL_MS = 60 * 1000;
const cache = new Map<string, { value: boolean; expiresAt: number }>();

async function readBooleanFlag(supabase: SupabaseClient, key: string, fallback: boolean): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const { data, error } = await supabase.from("app_config").select("value").eq("key", key).maybeSingle();
  // A failed read keeps the last known value, else the fallback. A missing row is "not set" → fallback.
  if (error) return hit?.value ?? fallback;
  const value = data ? data.value === true : fallback;
  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

/**
 * app_config.web_campaign_create_enabled — whether web campaign creation is available.
 * Defaults to OFF: a missing row or a failed first read hides it.
 */
export function isWebCampaignCreateEnabled(supabase: SupabaseClient): Promise<boolean> {
  return readBooleanFlag(supabase, "web_campaign_create_enabled", false);
}
