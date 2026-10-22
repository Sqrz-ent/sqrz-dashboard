import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-campaign-toggle (2026-10-22)
//
// Manual Pause/Resume for a LIVE campaign already running on Meta — lets the
// artist stop/restart delivery to save budget or focus spend on key days,
// without touching anything else about the campaign (no edit, no re-review,
// no new Meta objects created — meta-campaign-create is untouched).
//
// Auth: the caller's own Supabase JWT, same manual-validation + user_owns_profile
// pattern as verify-campaign-activation / meta-insights-sync's user-triggered
// path. Deployed verify_jwt:true since this function has no other caller.
//
// Eligibility: only a campaign at status='live' WITH a meta_campaign_id (i.e.
// already approved and actually running) can be toggled — anything else
// (still in review, rejected, completed, never synced to Meta) is rejected
// with a specific error code rather than silently no-opping.
//
// Credential resolution: the SAME "first active meta_ad_accounts row" lookup
// meta-campaign-create uses — never a second/different resolution path.
//
// State: deliberately NOT boost_campaigns.status (that stays 'live' — see
// the is_paused column's own comment, and the report on meta-status-webhook/
// meta-insights-sync's existing behavior). Two things get written:
//   - boost_campaigns.is_paused / paused_at — current state, one row per
//     campaign, latest value only.
//   - boost_campaign_toggle_log — append-only, one row per toggle, with a
//     timestamp, independent of the current-state columns above.
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

type MetaError = { message?: string; code?: number; error_subcode?: number };

// Same shape as meta-campaign-create's metaPost — token in the Authorization
// header, form-urlencoded body, Meta's error object surfaced in the thrown
// message rather than discarded.
async function metaPost(
  path: string,
  token: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(`POST ${path} → ${res.status}${err?.message ? ` ${err.message}` : ""}`);
  }
  return body;
}

type Body = {
  campaign_id?: string;
  action?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) return json({ error: "unauthorized" }, 401);

  const { data: userData, error: userErr } = await supabase.auth.getUser(bearerToken);
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const campaignId = body.campaign_id;
  const action = body.action;
  if (!campaignId || (action !== "pause" && action !== "resume")) {
    return json(
      { error: "invalid_action", message: "campaign_id and action ('pause'|'resume') are required." },
      400,
    );
  }

  // ── Load the campaign ──
  const { data: campaign, error: campErr } = await supabase
    .from("boost_campaigns")
    .select("id, profile_id, status, meta_campaign_id, is_paused")
    .eq("id", campaignId)
    .maybeSingle();
  if (campErr) return json({ error: `campaign lookup: ${campErr.message}` }, 500);
  if (!campaign) return json({ error: "campaign_not_found" }, 404);

  // ── Ownership — through a client scoped to the caller's own JWT, so
  // auth.uid() resolves inside the RLS helper (same pattern as
  // verify-campaign-activation / meta-insights-sync's user-triggered path). ──
  const userScoped = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: owns, error: ownsErr } = await userScoped.rpc("user_owns_profile", {
    p_profile_id: campaign.profile_id,
  });
  if (ownsErr || owns !== true) return json({ error: "not_owner" }, 403);

  // ── Eligibility: live + already synced to Meta ──
  if (campaign.status?.toLowerCase() !== "live") {
    return json(
      { error: "campaign_not_live", message: "Only a live campaign can be paused or resumed." },
      409,
    );
  }
  if (!campaign.meta_campaign_id) {
    return json(
      { error: "not_synced_to_meta", message: "This campaign hasn't been synced to Meta yet." },
      409,
    );
  }

  // ── Idempotent no-op if already in the requested state ──
  const alreadyPaused = campaign.is_paused === true;
  if (action === "pause" && alreadyPaused) {
    return json({ ok: true, is_paused: true, already: true });
  }
  if (action === "resume" && !alreadyPaused) {
    return json({ ok: true, is_paused: false, already: true });
  }

  // ── Credential resolution — SAME lookup meta-campaign-create uses, never
  // hardcoded, never a second resolution path. ──
  const { data: acctRow, error: acctErr } = await supabase
    .from("meta_ad_accounts")
    .select("ad_account_id, system_user_token")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (acctErr) return json({ error: `ad account lookup: ${acctErr.message}` }, 500);
  if (!acctRow) return json({ error: "no_active_ad_account" }, 500);

  const metaStatus = action === "pause" ? "PAUSED" : "ACTIVE";

  // Dry-run-verifiable: logs the exact request before sending it, so the
  // payload can be confirmed from function logs alone (per the task's own
  // testing instruction — no real campaign to toggle against in this pass).
  console.log(
    `[meta-campaign-toggle] ${campaignId} → POST ${campaign.meta_campaign_id} { status: "${metaStatus}" }`,
  );

  try {
    await metaPost(campaign.meta_campaign_id, acctRow.system_user_token as string, {
      status: metaStatus,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[meta-campaign-toggle] ${campaignId} Meta call failed:`, message);
    return json({ error: "meta_api_error", message }, 502);
  }

  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = { is_paused: action === "pause" };
  if (action === "pause") update.paused_at = nowIso;

  const { error: updateErr } = await supabase
    .from("boost_campaigns")
    .update(update)
    .eq("id", campaignId);
  if (updateErr) {
    // Meta's side already toggled successfully at this point — log and
    // surface a distinct error code so the client knows the DB write (not
    // the actual pause/resume) is what failed, rather than retrying the
    // Meta call too.
    console.error(`[meta-campaign-toggle] ${campaignId} DB update failed:`, updateErr.message);
    return json({ error: "db_update_failed", message: updateErr.message }, 500);
  }

  const { error: logErr } = await supabase.from("boost_campaign_toggle_log").insert({
    campaign_id: campaignId,
    profile_id: campaign.profile_id,
    action,
    toggled_at: nowIso,
  });
  if (logErr) {
    // The toggle itself fully succeeded (Meta + current-state column) — a
    // failed audit-log insert is logged, not surfaced as a failed toggle.
    console.error(`[meta-campaign-toggle] ${campaignId} toggle log insert failed:`, logErr.message);
  }

  return json({ ok: true, is_paused: action === "pause" });
});
