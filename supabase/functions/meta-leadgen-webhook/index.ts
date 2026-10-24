import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-leadgen-webhook (2026-10-25)
//
// Inbound Meta → SQRZ webhook for the Page object's `leadgen` field — a real
// Instant Form lead landing in Meta fires this, and it's turned into a row
// in `leads` (source='meta_lead_ads'), attributed to the boost_campaigns row
// that drove it via its meta_ad_id (falling back to meta_leadgen_form_id).
// The outbound direction (SQRZ creating the form/campaign) is
// meta-campaign-create + _shared/meta-leadgen-form.ts.
//
// This is a DIFFERENT object/field subscription from meta-status-webhook
// (which subscribes to the ad_account object's with_issues_ad_objects /
// in_process_ad_objects fields) — a separate function, not touched here.
//
// Auth: Meta's own webhook scheme, same shape as meta-status-webhook (copied
// verbatim, kept in sync by hand — no shared module exists for a one-line
// HMAC check yet). GET handshake echoes hub.challenge when hub.verify_token
// matches META_WEBHOOK_VERIFY_TOKEN. POST verifies X-Hub-Signature-256 =
// HMAC-SHA256(META_APP_SECRET, raw body), fail-closed. Both secrets are
// already set (meta-status-webhook already uses them) — this just adds a
// second App Dashboard Webhooks subscription (Page object, leadgen field)
// pointed at this function's own URL; no new secret needed.
//
// Page access token: derived per-lead from the webhook payload's own
// page_id, using the system-user → Page-token derivation
// (getPageAccessToken below) — duplicated from
// _shared/meta-leadgen-form.ts's own getPageAccessToken rather than
// imported (that function isn't exported, and this project's _shared/
// convention is to duplicate small helpers unless a cross-function drift
// bug specifically warrants sharing). Never logs the token.
//
// Always returns 200 once the signature itself is valid — a single lead
// that can't be fetched/resolved is logged and skipped, not surfaced as a
// webhook failure, so Meta doesn't keep retrying a lead we can never
// resolve. leads.meta_lead_id is UNIQUE; the insert upserts on it with
// ignoreDuplicates so a genuine Meta retry of the same leadgen_id is a
// harmless no-op rather than a duplicate row.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const META_WEBHOOK_VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN") ?? "";
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v26.0";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function text(body: string, status = 200): Response {
  return new Response(body, { status });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── Signature verification — copied verbatim from meta-status-webhook,
// which this pass does not modify. ─────────────────────────────────────────
async function verifySignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!META_APP_SECRET) {
    console.error("[meta-leadgen-webhook] META_APP_SECRET not set — rejecting (fail closed)");
    return false;
  }
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length).trim();

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ── Payload extraction ───────────────────────────────────────────────────────

type LeadgenChange = {
  leadgenId: string;
  formId: string | null;
  adId: string | null;
  pageId: string | null;
  createdTime: number | null;
};

function pickString(v: Record<string, unknown>, key: string): string | null {
  const val = v[key];
  if (typeof val === "string" && val.length > 0) return val;
  if (typeof val === "number") return String(val);
  return null;
}

// Meta's leadgen webhook payload carries no campaign_id at all — only
// leadgen_id/form_id/ad_id/page_id/created_time (ad_id absent for a test
// lead, which has no ad behind it). Non-"leadgen" fields are logged and
// skipped individually, not treated as a payload error.
function extractLeadgenChanges(payload: unknown): LeadgenChange[] {
  const out: LeadgenChange[] = [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const field = (change as { field?: unknown }).field;
      if (field !== "leadgen") {
        console.log("[meta-leadgen-webhook] ignoring non-leadgen field:", field);
        continue;
      }
      const rawValue = (change as { value?: unknown }).value;
      const v: Record<string, unknown> = rawValue && typeof rawValue === "object" ? (rawValue as Record<string, unknown>) : {};
      const leadgenId = pickString(v, "leadgen_id");
      if (!leadgenId) {
        console.log("[meta-leadgen-webhook] leadgen change with no leadgen_id, skipping:", JSON.stringify(v));
        continue;
      }
      out.push({
        leadgenId,
        formId: pickString(v, "form_id"),
        adId: pickString(v, "ad_id"),
        pageId: pickString(v, "page_id"),
        createdTime: v.created_time != null ? Number(v.created_time) : null,
      });
    }
  }
  return out;
}

// ── Page access token (duplicated from _shared/meta-leadgen-form.ts's own
// getPageAccessToken — see file header) ─────────────────────────────────────

type MetaError = { message?: string; code?: number; error_subcode?: number };

function metaErrorMessage(err: MetaError): string {
  return `message=${err.message ?? "(none)"} code=${err.code ?? "(none)"} error_subcode=${err.error_subcode ?? "(none)"}`;
}

async function getPageAccessToken(pageId: string, systemUserToken: string): Promise<string> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}`);
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("access_token", systemUserToken);
  const res = await fetch(url.toString());
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(err ? metaErrorMessage(err) : `GET ${pageId} (access_token) → HTTP ${res.status}`);
  }
  const token = body.access_token as string | undefined;
  if (!token) throw new Error(`GET ${pageId} (access_token) → no access_token field in response`);
  return token;
}

// ── Lead detail fetch — full field list, one retry with the core set if
// Meta rejects an optional field ─────────────────────────────────────────────

type FieldDatum = { name?: string; values?: string[] };

type LeadDetail = {
  id: string;
  fieldData: FieldDatum[];
  adId: string | null;
  formId: string | null;
};

const FULL_FIELDS = "id,created_time,field_data,ad_id,form_id,campaign_id,adset_id,platform,is_organic";
const CORE_FIELDS = "id,created_time,field_data,ad_id,form_id";

function parseLeadDetail(body: Record<string, unknown>): LeadDetail {
  return {
    id: body.id as string,
    fieldData: (body.field_data as FieldDatum[] | undefined) ?? [],
    adId: (body.ad_id as string | undefined) ?? null,
    formId: (body.form_id as string | undefined) ?? null,
  };
}

async function fetchLeadDetail(leadgenId: string, pageToken: string): Promise<LeadDetail> {
  const attempt = async (fields: string): Promise<Record<string, unknown>> => {
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("access_token", pageToken);
    const res = await fetch(url.toString());
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = body.error as MetaError | undefined;
    if (!res.ok || err) {
      throw new Error(err ? metaErrorMessage(err) : `GET ${leadgenId} → HTTP ${res.status}`);
    }
    return body;
  };

  try {
    return parseLeadDetail(await attempt(FULL_FIELDS));
  } catch (e) {
    console.error(`[meta-leadgen-webhook] full-field lead fetch failed for ${leadgenId}, retrying with core fields:`, e);
    return parseLeadDetail(await attempt(CORE_FIELDS));
  }
}

// ── field_data helpers ───────────────────────────────────────────────────────

function answerFor(fieldData: FieldDatum[], name: string): string | null {
  return fieldData.find((f) => f.name === name)?.values?.[0] ?? null;
}

function deriveName(fieldData: FieldDatum[]): string | null {
  const fullName = answerFor(fieldData, "full_name");
  if (fullName) return fullName;
  const first = answerFor(fieldData, "first_name");
  const last = answerFor(fieldData, "last_name");
  const combined = [first, last].filter((s): s is string => !!s).join(" ").trim();
  return combined.length > 0 ? combined : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && META_WEBHOOK_VERIFY_TOKEN && token === META_WEBHOOK_VERIFY_TOKEN) {
      return text(challenge ?? "", 200);
    }
    return text("Forbidden", 403);
  }

  if (req.method !== "POST") return text("Method not allowed", 405);

  const rawBody = await req.text();
  const sigOk = await verifySignature(rawBody, req.headers.get("x-hub-signature-256"));
  if (!sigOk) {
    console.error("[meta-leadgen-webhook] signature verification failed");
    return text("Invalid signature", 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return text("Invalid JSON", 400);
  }

  const changes = extractLeadgenChanges(payload);
  console.log("[meta-leadgen-webhook] received:", JSON.stringify(payload), "| extracted:", JSON.stringify(changes));

  // Active ad account's system-user token — same lookup meta-campaign-create
  // and meta-leadgen-form use (never hardcoded, first active row).
  const { data: acctRow, error: acctErr } = await supabase
    .from("meta_ad_accounts")
    .select("system_user_token")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (acctErr || !acctRow?.system_user_token) {
    console.error("[meta-leadgen-webhook] no active meta_ad_accounts row — cannot derive a Page token for this delivery");
    return json({
      ok: true,
      processed: changes.map((c) => ({ leadgen_id: c.leadgenId, skipped: "no active ad account" })),
    });
  }
  const systemUserToken = acctRow.system_user_token as string;

  const results: unknown[] = [];

  for (const change of changes) {
    try {
      if (!change.pageId) {
        results.push({ leadgen_id: change.leadgenId, skipped: "no page_id on the change" });
        continue;
      }

      const pageToken = await getPageAccessToken(change.pageId, systemUserToken);
      const detail = await fetchLeadDetail(change.leadgenId, pageToken);

      const adId = detail.adId ?? change.adId;
      const formId = detail.formId ?? change.formId;

      // First meta_ad_id, falling back to meta_leadgen_form_id when there's
      // no ad_id at all (test leads) or no row matches it.
      let campaign: { id: string; profile_id: string } | null = null;
      if (adId) {
        const { data } = await supabase
          .from("boost_campaigns")
          .select("id, profile_id")
          .eq("meta_ad_id", adId)
          .maybeSingle();
        campaign = data ?? null;
      }
      if (!campaign && formId) {
        const { data } = await supabase
          .from("boost_campaigns")
          .select("id, profile_id")
          .eq("meta_leadgen_form_id", formId)
          .maybeSingle();
        campaign = data ?? null;
      }

      if (!campaign) {
        console.error(
          `[meta-leadgen-webhook] could not resolve a campaign — leadgen_id=${change.leadgenId} form_id=${formId ?? "(none)"} page_id=${change.pageId}`,
        );
        results.push({ leadgen_id: change.leadgenId, form_id: formId, page_id: change.pageId, skipped: "no matching campaign" });
        continue;
      }

      // Upsert on meta_lead_id (UNIQUE) so a Meta retry of the same
      // leadgen_id never duplicates the row.
      const { error: insertErr } = await supabase
        .from("leads")
        .upsert(
          {
            profile_id: campaign.profile_id,
            campaign_id: campaign.id,
            source: "meta_lead_ads",
            meta_lead_id: detail.id,
            meta_form_id: formId,
            answers: detail.fieldData,
            name: deriveName(detail.fieldData),
            email: answerFor(detail.fieldData, "email"),
            message: null,
          },
          { onConflict: "meta_lead_id", ignoreDuplicates: true },
        );

      if (insertErr) {
        console.error(`[meta-leadgen-webhook] lead upsert failed for leadgen_id=${change.leadgenId}:`, insertErr.message);
        results.push({ leadgen_id: change.leadgenId, campaign_id: campaign.id, error: insertErr.message });
        continue;
      }

      results.push({ leadgen_id: change.leadgenId, campaign_id: campaign.id, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[meta-leadgen-webhook] failed processing leadgen_id=${change.leadgenId}:`, message);
      results.push({ leadgen_id: change.leadgenId, error: message });
    }
  }

  return json({ ok: true, processed: results });
});
