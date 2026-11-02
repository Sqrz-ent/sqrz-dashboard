import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleSandboxRequest } from "../_shared/outlets/sandbox-handler.ts";
import { TikTokAdsAdapter, tiktokConfigFromEnv } from "../_shared/outlets/tiktok.ts";

// ─────────────────────────────────────────────────────────────────────────────
// sandbox-tiktok
//
// ISOLATED SANDBOX — not called by the app, no triggers, no cron, reads/writes
// nothing in the live schema. Only touches outlet_sandbox.* (direct Postgres
// connection) and the tiktok ads API. Same pattern as sandbox-google-ads.
//
// POST { action: "ping" | "upload_asset" | "create_campaign" | "insights" | "pause",
//        params: {...} }
// Auth: header x-sandbox-key must equal secret SANDBOX_ADMIN_KEY, else 401.
// Deploy with verify_jwt:false. Everything created is paused/draft; final URLs
// are always https://<slug>.sqrz.com. See docs/outlets/tiktok.md.
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve((req) =>
  handleSandboxRequest(req, {
    outlet: "tiktok",
    makeAdapter: () => new TikTokAdsAdapter(tiktokConfigFromEnv()),
  })
);
