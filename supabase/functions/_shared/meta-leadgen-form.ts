// ─────────────────────────────────────────────────────────────────────────────
// _shared/meta-leadgen-form.ts (2026-10-25)
//
// Creates (or reuses) a Meta Instant Form (leadgen_forms) for a campaign
// whose template has creative_source='lead_form', and writes the created
// form id back onto the owning boost_campaigns row — same idempotent
// "already has X" short-circuit shape as meta_campaign_id in
// meta-campaign-create.
//
// Wired in (2026-10-25) — meta-campaign-create's lead_form creative branch
// is the one call site, calling ensureLeadgenForm before building the
// creative for any campaign whose resolved template has
// creative_source==='lead_form'.
// ─────────────────────────────────────────────────────────────────────────────

const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v26.0";

// Interim override (2026-10-25) — a non-expiring Page token for ONE Page,
// generated from Will's own login, used until leads_retrieval has Advanced
// Access for the system user (see root CLAUDE.md's Known Open Issues: the
// system user already has every Page task incl. MANAGE, and leads_retrieval
// in its token scopes, but subscribed_apps still 403s with "one of these
// permissions is needed: leads_retrieval" — an App-Review/Advanced-Access
// gap, not a Page-task or token-scope gap). Optional; unset = no override,
// exactly today's system-user-derived behavior.
const META_LEADS_PAGE_TOKEN = Deno.env.get("META_LEADS_PAGE_TOKEN") ?? "";

export type LeadFormQuestion = {
  type: "FULL_NAME" | "EMAIL" | "PHONE" | "CUSTOM";
  key?: string;
  label?: string;
  options?: { key: string; value: string }[];
};

export type LeadFormConfig = {
  name: string;
  locale?: string;
  privacy_policy?: { url: string; link_text?: string };
  questions?: LeadFormQuestion[];
  thank_you_page?: {
    title?: string;
    body?: string;
    button_type?: string;
    button_text?: string;
    website_url?: string;
  };
};

type MinimalCampaign = { id: string; profile_id: string; meta_leadgen_form_id: string | null };
type MinimalTemplate = { id: string; lead_form_config: LeadFormConfig | null };

type MetaError = { message?: string; code?: number; error_subcode?: number };

// Minimal shape of whatever Supabase client the caller already has (admin or
// otherwise) — same convention as _shared/meta-instagram.ts's MinimalSupabase.
// select(...) added alongside the existing update(...) shape — needed to
// resolve the campaign's profile slug for the {profile_url} placeholder.
type MinimalSupabase = {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
    select(columns: string): {
      eq(column: string, value: unknown): {
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
      };
    };
  };
};

// Deep-replaces every "{profile_url}" occurrence in any string value of a
// LeadFormConfig (including inside nested objects/arrays, e.g. questions[],
// privacy_policy, thank_you_page) — a fresh copy, the source config is never
// mutated.
function replaceProfileUrlPlaceholder<T>(value: T, profileUrl: string): T {
  if (typeof value === "string") {
    return value.split("{profile_url}").join(profileUrl) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => replaceProfileUrlPlaceholder(v, profileUrl)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = replaceProfileUrlPlaceholder(v, profileUrl);
    }
    return out as T;
  }
  return value;
}

// Deliberately keeps message/code/error_subcode verbatim rather than folding
// them into a prose string — the caller stores this directly in
// meta_sync_error, and a Lead Ads Terms of Service rejection (or any other
// Graph error) needs each piece legible on its own, not paraphrased away.
function metaErrorMessage(err: MetaError): string {
  return `Meta leadgen_forms error: message=${err.message ?? "(none)"} code=${err.code ?? "(none)"} error_subcode=${err.error_subcode ?? "(none)"}`;
}

// Which Page META_LEADS_PAGE_TOKEN belongs to — resolved once via
// GET /me?fields=id (a Page token's own /me returns that Page's id) and
// cached for the isolate's lifetime. `undefined` = not yet resolved;
// `null` = unset or resolution failed, meaning the override never applies.
// Never logs the token itself — only the outcome, and only on failure.
let leadsOverridePageId: string | null | undefined;

async function resolveLeadsOverridePageId(): Promise<string | null> {
  if (leadsOverridePageId !== undefined) return leadsOverridePageId;
  if (!META_LEADS_PAGE_TOKEN) {
    leadsOverridePageId = null;
    return null;
  }
  try {
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("access_token", META_LEADS_PAGE_TOKEN);
    const res = await fetch(url.toString());
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = body.error as MetaError | undefined;
    if (!res.ok || err) {
      console.error(
        `[meta-leadgen-form] META_LEADS_PAGE_TOKEN /me lookup failed${err ? `: ${metaErrorMessage(err)}` : ` (HTTP ${res.status})`}`,
      );
      leadsOverridePageId = null;
    } else {
      leadsOverridePageId = (body.id as string | undefined) ?? null;
    }
  } catch (e) {
    console.error("[meta-leadgen-form] META_LEADS_PAGE_TOKEN /me lookup threw:", e instanceof Error ? e.message : String(e));
    leadsOverridePageId = null;
  }
  return leadsOverridePageId;
}

// Page access token derivation — same call shape as meta-page-posts' local
// getPageTokenAndInstagram (GET /{page_id}?fields=access_token using the
// system user token), minus the Instagram lookup that helper also does,
// which this has no use for. Duplicated rather than imported, per this
// project's _shared/ convention: small helpers are duplicated per function
// unless a cross-function drift bug specifically warrants sharing (see
// _shared/meta-instagram.ts's own header for the one case that did). Never
// logs the token — a failure here throws Meta's own error fields only.
//
// META_LEADS_PAGE_TOKEN override (2026-10-25): if set and it resolves to
// this exact pageId, returned directly — no system-user call at all. Any
// other pageId, an unset secret, or a failed /me resolution falls through
// to the system-user derivation exactly as before.
async function getPageAccessToken(pageId: string, systemUserToken: string): Promise<string> {
  const overridePageId = await resolveLeadsOverridePageId();
  if (overridePageId && overridePageId === pageId) {
    console.log(`[meta-leadgen-form] page token source: override, pageId=${pageId}`);
    return META_LEADS_PAGE_TOKEN;
  }

  console.log(`[meta-leadgen-form] page token source: system_user, pageId=${pageId}`);
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

export async function ensureLeadgenForm(args: {
  supabase: MinimalSupabase;
  campaign: MinimalCampaign;
  template: MinimalTemplate;
  pageId: string;
  systemUserToken: string;
}): Promise<string> {
  const { supabase, campaign, template, pageId, systemUserToken } = args;

  // Idempotent short-circuit — same shape as meta_campaign_id's own
  // "already has X" check in meta-campaign-create.
  if (campaign.meta_leadgen_form_id) return campaign.meta_leadgen_form_id;

  const config = template.lead_form_config;
  if (!config) {
    throw new Error(`Template ${template.id} has no lead_form_config`);
  }

  // {profile_url} support — resolved fresh every call (not cached; profile
  // slugs are rare/one-time writes, not worth the complexity of caching
  // here). Substitution happens on a deep copy — the template row's own
  // lead_form_config is never mutated.
  const { data: profileRow, error: profileErr } = await supabase
    .from("profiles")
    .select("slug")
    .eq("id", campaign.profile_id)
    .maybeSingle();
  const slug = profileRow?.slug as string | undefined;
  if (profileErr || !slug) {
    throw new Error(`Could not resolve profile slug for campaign ${campaign.id}`);
  }
  const profileUrl = `https://${slug}.sqrz.com`;
  const substitutedConfig = replaceProfileUrlPlaceholder(config, profileUrl);

  const pageToken = await getPageAccessToken(pageId, systemUserToken);

  // Meta allows duplicate form names on the same Page — a stable,
  // campaign-scoped suffix keeps them distinguishable in Meta's own UI
  // without depending on that. Short: first 8 hex chars of the campaign's
  // uuid, hyphens stripped.
  const shortSuffix = campaign.id.replace(/-/g, "").slice(0, 8);

  const form = new URLSearchParams();
  form.set("access_token", pageToken);
  form.set("name", `${substitutedConfig.name} — ${shortSuffix}`);
  if (substitutedConfig.locale) form.set("locale", substitutedConfig.locale);
  // Objects/arrays go over as JSON-encoded form fields — Graph expects the
  // string-encoded form, not nested multipart/JSON body fields.
  if (substitutedConfig.questions) form.set("questions", JSON.stringify(substitutedConfig.questions));
  if (substitutedConfig.privacy_policy) form.set("privacy_policy", JSON.stringify(substitutedConfig.privacy_policy));
  if (substitutedConfig.thank_you_page) form.set("thank_you_page", JSON.stringify(substitutedConfig.thank_you_page));

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/leadgen_forms`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(err ? metaErrorMessage(err) : `POST ${pageId}/leadgen_forms → HTTP ${res.status}`);
  }
  const formId = body.id as string | undefined;
  if (!formId) throw new Error(`POST ${pageId}/leadgen_forms → no id in response`);

  const { error: updateErr } = await supabase
    .from("boost_campaigns")
    .update({ meta_leadgen_form_id: formId })
    .eq("id", campaign.id);
  if (updateErr) {
    console.error(
      `[meta-leadgen-form] failed to store meta_leadgen_form_id for campaign ${campaign.id}:`,
      updateErr.message,
    );
  }

  return formId;
}
