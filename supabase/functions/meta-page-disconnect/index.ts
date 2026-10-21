import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-page-disconnect
//
// Disconnects a profile's Facebook Page connection. Best-effort removal of
// SQRZ's business-asset access on Meta's side (DELETE on the business's
// client_pages edge) — Meta's docs don't explicitly document the removal
// shape for a client-Page grant the way they document creating one, so this
// is attempted but never blocks the local disconnect: the row is ALWAYS set
// to 'revoked' regardless of whether the remote call succeeds. If the remote
// delete fails, the artist is still shown as disconnected on SQRZ's side
// (meta-campaign-create falls back to SQRZ's own identity immediately), and
// stale remote access can be cleaned up manually from Business Suite if it
// ever matters.
//
// Auth: same manual JWT + user_owns_profile pattern as the other two
// meta-page-* functions.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) return json({ error: "unauthorized" }, 401);

  const { data: userData, error: userErr } = await supabase.auth.getUser(bearerToken);
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  let body: { profile_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const profileId = body.profile_id;
  if (!profileId) return json({ error: "missing_fields", message: "profile_id is required." }, 400);

  const userScoped = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: owns, error: ownsErr } = await userScoped.rpc("user_owns_profile", { p_profile_id: profileId });
  if (ownsErr || owns !== true) return json({ error: "unauthorized" }, 403);

  const { data: connection, error: connErr } = await supabase
    .from("profile_meta_connections")
    .select("page_id, status")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (connErr) return json({ error: `connection lookup: ${connErr.message}` }, 500);
  if (!connection || connection.status === "revoked") {
    return json({ ok: true, status: "revoked" });
  }

  if (connection.page_id) {
    const { data: acctRow } = await supabase
      .from("meta_ad_accounts")
      .select("business_id, system_user_token")
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (acctRow?.business_id) {
      try {
        const url = new URL(`${GRAPH}/${acctRow.business_id}/client_pages`);
        url.searchParams.set("page_id", connection.page_id);
        const res = await fetch(url.toString(), {
          method: "DELETE",
          headers: { Authorization: `Bearer ${acctRow.system_user_token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          console.warn(
            `[meta-page-disconnect] remote removal returned ${res.status} for profile ${profileId}:`,
            JSON.stringify(body),
          );
        }
      } catch (e) {
        // Best-effort — see file header. Never blocks the local disconnect.
        console.warn(`[meta-page-disconnect] remote removal failed for profile ${profileId}:`, e);
      }
    }
  }

  await supabase
    .from("profile_meta_connections")
    .update({ status: "revoked", error: null })
    .eq("profile_id", profileId);

  return json({ ok: true, status: "revoked" });
});
