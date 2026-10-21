import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-page-connection-status
//
// Checks a profile's Facebook Page connection (profile_meta_connections)
// against Meta's own current truth and updates the stored status to match.
// Callable on demand from the app ("Check status" button) — also fine to call
// repeatedly, it's read-mostly against Meta.
//
// There's no single Graph API field for "is this specific client-Page request
// approved yet" — Meta exposes two separate business edges instead:
//   GET /{business_id}/client_pages           → pages the business has been
//                                                 GRANTED access to (approved)
//   GET /{business_id}/pending_client_pages    → pages still awaiting the
//                                                 Page admin's approval
// A page_id found in neither list, after having been pending, means the
// admin declined it (or removed access later) — mapped to 'failed'/'revoked'
// respectively below.
//
// Auth: same manual JWT + user_owns_profile pattern as meta-page-connect.
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

async function metaGetPageIds(path: string, token: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | undefined;
  do {
    const url = new URL(`${GRAPH}/${path}`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("limit", "200");
    if (after) url.searchParams.set("after", after);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = body.error as { message?: string } | undefined;
    if (!res.ok || err) {
      throw new Error(`GET ${path} → ${res.status}${err?.message ? ` ${err.message}` : ""}`);
    }
    for (const row of (body.data as { id?: string }[] | undefined) ?? []) {
      if (row.id) ids.add(row.id);
    }
    const paging = body.paging as { next?: string; cursors?: { after?: string } } | undefined;
    after = paging?.next ? paging.cursors?.after : undefined;
  } while (after);
  return ids;
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
    .select("*")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (connErr) return json({ error: `connection lookup: ${connErr.message}` }, 500);
  if (!connection) return json({ ok: true, connection: null });

  // 'revoked'/'failed' are terminal from this function's point of view —
  // reconnecting creates a fresh 'pending' row via meta-page-connect, so
  // there's nothing further to check against Meta for either state here.
  if (connection.status === "revoked" || connection.status === "failed") {
    return json({ ok: true, connection });
  }

  const { data: acctRow, error: acctErr } = await supabase
    .from("meta_ad_accounts")
    .select("business_id, system_user_token")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (acctErr) return json({ error: `ad account lookup: ${acctErr.message}` }, 500);
  if (!acctRow?.business_id) {
    return json({ error: "no_business_id", message: "No active Meta business account configured." }, 500);
  }

  const now = new Date().toISOString();
  let approvedIds: Set<string>;
  let pendingIds: Set<string>;
  try {
    [approvedIds, pendingIds] = await Promise.all([
      metaGetPageIds(`${acctRow.business_id}/client_pages`, acctRow.system_user_token as string),
      metaGetPageIds(`${acctRow.business_id}/pending_client_pages`, acctRow.system_user_token as string),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[meta-page-connection-status] Meta lookup failed for profile ${profileId}:`, message);
    await supabase
      .from("profile_meta_connections")
      .update({ last_checked_at: now, error: message.slice(0, 1000) })
      .eq("profile_id", profileId);
    return json({ error: "status_check_failed", message }, 502);
  }

  const pageId = connection.page_id as string | null;
  let nextStatus = connection.status as string;
  let error: string | null = null;
  let approvedAt = connection.approved_at as string | null;

  if (pageId && approvedIds.has(pageId)) {
    nextStatus = "active";
    approvedAt = approvedAt ?? now;
  } else if (pageId && pendingIds.has(pageId)) {
    nextStatus = "pending";
  } else if (connection.status === "active") {
    // Was active, no longer in the approved list — access was removed on
    // Meta's side (e.g. the admin revoked it from Business Suite directly).
    nextStatus = "revoked";
    error = "Access was removed in Meta Business Suite.";
  } else {
    // Was pending, now in neither list — the admin declined the request.
    nextStatus = "failed";
    error = "The request was declined in Meta Business Suite.";
  }

  const { data: updated, error: updateErr } = await supabase
    .from("profile_meta_connections")
    .update({ status: nextStatus, approved_at: approvedAt, last_checked_at: now, error })
    .eq("profile_id", profileId)
    .select("*")
    .single();
  if (updateErr) return json({ error: `update failed: ${updateErr.message}` }, 500);

  return json({ ok: true, connection: updated });
});
