import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-page-connect
//
// Starts the "connect your Facebook Page" flow for one profile (v1, 2026-10-21).
// The artist's Facebook login is used CLIENT-SIDE ONLY (iOS) to list their Pages
// and each Page's linked Instagram account — this function never sees that
// token. It receives the page the artist already picked and sends SQRZ's own
// business-asset-sharing request for it ("client Page" request, ADVERTISE task
// only — never full admin) using SQRZ's own system-user credentials
// (meta_ad_accounts.system_user_token), then records the connection as pending.
//
// Approval happens entirely in Meta Business Suite, on the Page admin's side —
// there is no API to approve a client-Page request, confirmed against Meta's
// current Business Asset Management docs. meta-page-connection-status is what
// later detects the approval.
//
// No separate request is needed for the linked Instagram account: per Meta's
// current Instagram Ads guide, ADVERTISE access on the Page is sufficient to
// use that Page's linked Instagram account as an ad identity too — the
// instagram_user_id/instagram_username here are stored for display and for
// meta-campaign-create's identity resolution, not sent to Meta as a separate
// grant request.
//
// Auth: the caller's own Supabase JWT (same manual-validation pattern as
// meta-insights-sync's user-triggered path) + user_owns_profile ownership
// check — deployed verify_jwt:true since this function has no other caller.
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

type MetaError = { message?: string; error_user_msg?: string; code?: number; error_subcode?: number };

function formatMetaError(err: MetaError | undefined): string {
  if (!err) return "";
  return [err.message, err.error_user_msg].filter(Boolean).join(" — ") ||
    `code=${err.code ?? "?"} subcode=${err.error_subcode ?? "?"}`;
}

async function metaPost(
  path: string,
  token: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(`POST ${path} → ${res.status}${err ? ` ${formatMetaError(err)}` : ""}`);
  }
  return body;
}

type ConnectBody = {
  profile_id?: string;
  page_id?: string;
  page_name?: string;
  instagram_user_id?: string | null;
  instagram_username?: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) return json({ error: "unauthorized" }, 401);

  const { data: userData, error: userErr } = await supabase.auth.getUser(bearerToken);
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  let body: ConnectBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const profileId = body.profile_id;
  const pageId = body.page_id;
  const pageName = body.page_name;
  if (!profileId || !pageId || !pageName) {
    return json({ error: "missing_fields", message: "profile_id, page_id, and page_name are required." }, 400);
  }

  // Ownership — through a client scoped to the caller's own JWT, so
  // auth.uid() resolves inside the RLS helper (same pattern as
  // meta-insights-sync's user-triggered refresh).
  const userScoped = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: owns, error: ownsErr } = await userScoped.rpc("user_owns_profile", { p_profile_id: profileId });
  if (ownsErr || owns !== true) return json({ error: "unauthorized" }, 403);

  // SQRZ's own business — never hardcoded, first active row (same lookup
  // meta-campaign-create uses for the ad account).
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

  try {
    await metaPost(`${acctRow.business_id}/client_pages`, acctRow.system_user_token as string, {
      page_id: pageId,
      permitted_tasks: ["ADVERTISE"],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[meta-page-connect] client_pages request failed for profile ${profileId}:`, message);
    // Record the attempt as failed rather than silently dropping it — the
    // artist picked a Page and should see *something* happened, not nothing.
    await supabase.from("profile_meta_connections").upsert({
      profile_id: profileId,
      page_id: pageId,
      page_name: pageName,
      instagram_user_id: body.instagram_user_id ?? null,
      instagram_username: body.instagram_username ?? null,
      status: "failed",
      requested_at: now,
      approved_at: null,
      last_checked_at: now,
      error: message.slice(0, 1000),
    }, { onConflict: "profile_id" });
    return json({ ok: false, error: "request_failed", message }, 502);
  }

  await supabase.from("profile_meta_connections").upsert({
    profile_id: profileId,
    page_id: pageId,
    page_name: pageName,
    instagram_user_id: body.instagram_user_id ?? null,
    instagram_username: body.instagram_username ?? null,
    status: "pending",
    requested_at: now,
    approved_at: null,
    last_checked_at: null,
    error: null,
  }, { onConflict: "profile_id" });

  return json({ ok: true, status: "pending" });
});
