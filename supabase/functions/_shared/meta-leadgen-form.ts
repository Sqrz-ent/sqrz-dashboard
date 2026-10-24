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

type MinimalCampaign = { id: string; meta_leadgen_form_id: string | null };
type MinimalTemplate = { id: string; lead_form_config: LeadFormConfig | null };

type MetaError = { message?: string; code?: number; error_subcode?: number };

// Minimal shape of whatever Supabase client the caller already has (admin or
// otherwise) — same convention as _shared/meta-instagram.ts's MinimalSupabase.
type MinimalSupabase = {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

// Deliberately keeps message/code/error_subcode verbatim rather than folding
// them into a prose string — the caller stores this directly in
// meta_sync_error, and a Lead Ads Terms of Service rejection (or any other
// Graph error) needs each piece legible on its own, not paraphrased away.
function metaErrorMessage(err: MetaError): string {
  return `Meta leadgen_forms error: message=${err.message ?? "(none)"} code=${err.code ?? "(none)"} error_subcode=${err.error_subcode ?? "(none)"}`;
}

// Page access token derivation — same call shape as meta-page-posts' local
// getPageTokenAndInstagram (GET /{page_id}?fields=access_token using the
// system user token), minus the Instagram lookup that helper also does,
// which this has no use for. Duplicated rather than imported, per this
// project's _shared/ convention: small helpers are duplicated per function
// unless a cross-function drift bug specifically warrants sharing (see
// _shared/meta-instagram.ts's own header for the one case that did). Never
// logs the token — a failure here throws Meta's own error fields only.
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

  const pageToken = await getPageAccessToken(pageId, systemUserToken);

  // Meta allows duplicate form names on the same Page — a stable,
  // campaign-scoped suffix keeps them distinguishable in Meta's own UI
  // without depending on that. Short: first 8 hex chars of the campaign's
  // uuid, hyphens stripped.
  const shortSuffix = campaign.id.replace(/-/g, "").slice(0, 8);

  const form = new URLSearchParams();
  form.set("access_token", pageToken);
  form.set("name", `${config.name} — ${shortSuffix}`);
  if (config.locale) form.set("locale", config.locale);
  // Objects/arrays go over as JSON-encoded form fields — Graph expects the
  // string-encoded form, not nested multipart/JSON body fields.
  if (config.questions) form.set("questions", JSON.stringify(config.questions));
  if (config.privacy_policy) form.set("privacy_policy", JSON.stringify(config.privacy_policy));
  if (config.thank_you_page) form.set("thank_you_page", JSON.stringify(config.thank_you_page));

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
