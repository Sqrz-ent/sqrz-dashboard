import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-campaign-create
//
// Pushes a configured boost_campaigns row to Meta as a real, PAUSED object chain:
// media upload → Campaign → Ad Set → Ad Creative → Ad. Writes meta_campaign_id /
// meta_adset_id / meta_ad_id back on the row. Everything is created PAUSED — the
// existing manual admin publish stays the final gate (matches special_ad_categories
// + "final publish is manual" requirement).
//
// Triggered (fire-and-forget, async) by on_boost_campaign_submit_meta_create when a
// Meta-channel campaign first reaches status='in_review' (creative submitted) with
// no meta_campaign_id yet. NOT user-invocable directly — guarded by the shared
// meta_sync_secret from Vault (same secret meta-insights-sync uses), injected as
// x-sync-secret by the trigger. Deploy verify_jwt:false (custom auth).
//
// V1 identity: SQRZ's own Facebook Page is the identity behind every ad (no
// per-artist Page). Page id is read from meta_ad_accounts.page_id, falling back to
// the META_PAGE_ID env or the business's first owned page (then cached back).
//
// Targeting: worldwide + Advantage+ audience, automatic placements — no manual
// audience-building UI exists in V1. An admin narrows targeting before un-pausing.
//
// Budget: the ad set is created with a lifetime_budget floor (Meta's per-account
// minimum × campaign days) when the campaign has no allocation yet; every later
// allocation re-PATCHes it via the sibling meta-adset-budget-sync function.
//
// Partial-failure handling: on any step failure we best-effort DELETE the objects
// already created (reverse order) so no orphaned chain is left, AND flag the row
// (meta_sync_status='failed' + meta_sync_error) with enough detail to debug/retry.
// Uploaded image/video assets are left in place (hash-deduped, reusable on retry).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const ENV_PAGE_ID = Deno.env.get("META_PAGE_ID") ?? "";

// Absolute last-resort floor if Meta doesn't report a per-account minimum
// (cents, account currency). 100 = e.g. $1.00/day, Meta's typical USD minimum.
const FALLBACK_MIN_DAILY_CENTS = 100;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Meta enum mappings (verified against Meta's real enums, not blind casing) ──

// Campaign objective (ODAX). Sending traffic to a profile / private-link URL, so
// TRAFFIC is the deliverable default; awareness/engagement for the softer goals.
function objectiveFor(goal: string | null): string {
  switch (goal) {
    case "visibility": return "OUTCOME_AWARENESS";
    case "audience":   return "OUTCOME_ENGAGEMENT";
    case "bookings":   return "OUTCOME_TRAFFIC";
    default:           return "OUTCOME_TRAFFIC";
  }
}

// Ad set optimization_goal paired with the objective. billing_event is IMPRESSIONS
// for all three (valid + simplest across objectives).
function optimizationGoalFor(objective: string): string {
  switch (objective) {
    case "OUTCOME_AWARENESS":  return "REACH";
    case "OUTCOME_ENGAGEMENT": return "POST_ENGAGEMENT";
    case "OUTCOME_TRAFFIC":    return "LINK_CLICKS";
    default:                    return "LINK_CLICKS";
  }
}

// call_to_action.type — book_now/learn_more/contact_us are all real Meta enum
// values (confirmed), so the map is an explicit uppercase for these three only,
// with LEARN_MORE as the safe default rather than passing an unknown value.
function ctaFor(ctaType: string | null): string {
  switch (ctaType) {
    case "book_now":    return "BOOK_NOW";
    case "learn_more":  return "LEARN_MORE";
    case "contact_us":  return "CONTACT_US";
    default:            return "LEARN_MORE";
  }
}

// ── Meta HTTP helpers (token in the Authorization header, never the query) ─────

// Meta's error object carries far more than `message` — error_user_title/
// error_user_msg are the human-readable "what's actually wrong" (e.g.
// "FileTypeNotSupported" / "The type of file is not supported."), and
// code/error_subcode/fbtrace_id are what you need to look it up or hand to
// Meta support. The old error handling here discarded all of that and kept
// only `message`, which is why a real adimages failure surfaced as nothing
// more than "400 Invalid parameter" in meta_sync_error — technically the
// message field, but useless for diagnosing which parameter or why.
type MetaError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
};

function formatMetaError(err: MetaError | undefined): string {
  if (!err) return "";
  const detail = [err.message, err.error_user_title, err.error_user_msg]
    .filter(Boolean)
    .join(" — ");
  const meta = [
    err.type ? `type=${err.type}` : null,
    err.code !== undefined ? `code=${err.code}` : null,
    err.error_subcode !== undefined ? `subcode=${err.error_subcode}` : null,
    err.fbtrace_id ? `fbtrace_id=${err.fbtrace_id}` : null,
  ].filter(Boolean).join(" ");
  return [detail, meta ? `(${meta})` : null].filter(Boolean).join(" ");
}

async function metaGet(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(`GET ${path} → ${res.status}${err ? ` ${formatMetaError(err)}` : ""}`);
  }
  return body;
}

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
    throw new Error(`POST ${path} → ${res.status}${err ? ` ${formatMetaError(err)}` : ""}`);
  }
  return body;
}

async function metaDelete(id: string, token: string): Promise<void> {
  // Best-effort — used only during rollback, so swallow errors (already failing).
  try {
    await fetch(`${GRAPH}/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (_e) { /* ignore */ }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type AdAccount = {
  id: string;
  ad_account_id: string;
  business_id: string | null;
  page_id: string | null;
  system_user_token: string;
  currency: string | null;
};

type CampaignRow = {
  id: string;
  profile_id: string;
  name: string | null;
  goal: string | null;
  cta_type: string | null;
  primary_text: string | null;
  headline: string | null;
  description: string | null;
  notes: string | null;
  creative_asset_url: string | null;
  utm_url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  meta_campaign_id: string | null;
};

// ── Page resolution: column → env → business owned_pages (cached back) ─────────

async function resolvePageId(acct: AdAccount): Promise<string> {
  if (acct.page_id) return acct.page_id;
  if (ENV_PAGE_ID) return ENV_PAGE_ID;
  if (!acct.business_id) {
    throw new Error("no page_id on the ad account and no business_id to resolve one");
  }
  const body = await metaGet(`${acct.business_id}/owned_pages`, acct.system_user_token, {
    fields: "id,name",
    limit: "1",
  });
  const page = (body.data as { id?: string }[] | undefined)?.[0];
  if (!page?.id) throw new Error("business has no owned pages to use as the ad identity");
  // Cache back so subsequent runs skip the extra call.
  await supabase.from("meta_ad_accounts").update({ page_id: page.id }).eq("id", acct.id);
  return page.id;
}

// ── Media upload ───────────────────────────────────────────────────────────────

const VIDEO_EXTS = ["mp4", "mov", "m4v", "webm"];

function isVideoUrl(url: string): boolean {
  const clean = url.split("?")[0].toLowerCase();
  return VIDEO_EXTS.some((ext) => clean.endsWith(`.${ext}`));
}

// Image → /adimages (multipart), returns the hash to reference in the creative.
async function uploadImage(acct: AdAccount, assetUrl: string): Promise<string> {
  const assetRes = await fetch(assetUrl);
  if (!assetRes.ok) throw new Error(`fetch creative asset → ${assetRes.status}`);
  const blob = await assetRes.blob();

  // Meta's /adimages endpoint determines file type from the multipart part's
  // filename EXTENSION — not the Content-Type header, not the actual bytes.
  // Confirmed directly against the live API: the identical bytes, posted
  // with an extensionless filename ("creative"), were rejected with
  // error_user_title "FileTypeNotSupported"; reposting the same bytes with
  // "creative.jpg" succeeded and returned a real hash. Derive the extension
  // from the asset URL (stripping the query string) rather than hardcoding
  // ".jpg", since campaign-creative isn't JPEG-only at the bucket level.
  const cleanPath = assetUrl.split("?")[0];
  const ext = cleanPath.includes(".") ? cleanPath.split(".").pop()! : "jpg";
  const filename = `creative.${ext}`;

  const form = new FormData();
  form.append("filename", blob, filename);
  const res = await fetch(`${GRAPH}/${acct.ad_account_id}/adimages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${acct.system_user_token}` },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(`adimages → ${res.status}${err ? ` ${formatMetaError(err)}` : ""}`);
  }
  // Shape: { images: { <filename>: { hash, url } } }
  const images = body.images as Record<string, { hash?: string }> | undefined;
  const first = images ? Object.values(images)[0] : undefined;
  if (!first?.hash) throw new Error("adimages returned no image hash");
  return first.hash;
}

// Video → /advideos with file_url (the asset is already a public profile-media
// URL, so file_url is the correct simple path — no chunked resumable protocol
// needed). Poll until processed, then read a thumbnail for the creative.
async function uploadVideo(
  acct: AdAccount,
  assetUrl: string,
): Promise<{ videoId: string; thumbnailUrl: string | null }> {
  const created = await metaPost(`${acct.ad_account_id}/advideos`, acct.system_user_token, {
    file_url: assetUrl,
  });
  const videoId = created.id as string | undefined;
  if (!videoId) throw new Error("advideos returned no video id");

  // Poll processing status (~ up to 60s) — a creative referencing an unprocessed
  // video is rejected.
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    try {
      const status = await metaGet(`${videoId}`, acct.system_user_token, { fields: "status" });
      const vs = (status.status as { video_status?: string } | undefined)?.video_status;
      if (vs === "ready") break;
      if (vs === "error") throw new Error("Meta reported video processing error");
    } catch (e) {
      // A transient read error mid-processing shouldn't abort — keep polling.
      if (i === 19) throw e;
    }
  }

  let thumbnailUrl: string | null = null;
  try {
    const thumbs = await metaGet(`${videoId}/thumbnails`, acct.system_user_token, { fields: "uri,is_preferred" });
    const list = (thumbs.data as { uri?: string; is_preferred?: boolean }[] | undefined) ?? [];
    thumbnailUrl = (list.find((t) => t.is_preferred)?.uri ?? list[0]?.uri) ?? null;
  } catch (_e) { /* thumbnail is best-effort */ }

  return { videoId, thumbnailUrl };
}

// ── Budget floor: Meta's per-account min daily budget × campaign days ──────────

function campaignDays(starts: string | null, ends: string | null): number {
  if (!starts || !ends) return 7;
  const ms = new Date(ends).getTime() - new Date(starts).getTime();
  const days = Math.round(ms / 86_400_000);
  return days >= 1 ? days : 7;
}

async function minDailyBudgetCents(acct: AdAccount): Promise<number> {
  try {
    const body = await metaGet(acct.ad_account_id, acct.system_user_token, {
      fields: "min_daily_budget",
    });
    const min = Number(body.min_daily_budget);
    if (Number.isFinite(min) && min > 0) return min;
  } catch (_e) { /* fall through to constant */ }
  return FALLBACK_MIN_DAILY_CENTS;
}

// ── Main ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Auth: shared secret from Vault (same as meta-insights-sync).
  const provided = req.headers.get("x-sync-secret") ?? "";
  const { data: expected, error: secretErr } = await supabase.rpc("get_meta_sync_secret");
  if (secretErr || !expected || provided !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  let campaignId: string;
  try {
    const payload = await req.json();
    campaignId = payload.campaign_id as string;
    if (!campaignId) throw new Error("missing campaign_id");
  } catch {
    return json({ error: "invalid payload" }, 400);
  }

  // Load campaign (+ idempotency guard) and the owning profile's slug/name.
  const { data: campaign, error: campErr } = await supabase
    .from("boost_campaigns")
    .select("id, profile_id, name, goal, cta_type, primary_text, headline, description, notes, creative_asset_url, utm_url, starts_at, ends_at, meta_campaign_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (campErr) return json({ error: `campaign lookup: ${campErr.message}` }, 500);
  if (!campaign) return json({ error: "campaign not found" }, 404);

  const c = campaign as CampaignRow;
  if (c.meta_campaign_id) {
    // Already pushed — idempotent no-op (e.g. a duplicate trigger delivery).
    return json({ ok: true, skipped: "already has meta_campaign_id" });
  }
  if (!c.creative_asset_url) {
    await flagFailed(campaignId, "no creative_asset_url — nothing to upload");
    return json({ error: "no creative asset" }, 200);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("slug, name, brand_name, first_name, last_name")
    .eq("id", c.profile_id)
    .maybeSingle();
  const slug = (profile?.slug as string | undefined) ?? "";
  const displayName =
    (profile?.brand_name as string) ||
    (profile?.name as string) ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
    slug ||
    "SQRZ Artist";

  // Active primary ad account (never hardcoded; first active row).
  const { data: acctRow, error: acctErr } = await supabase
    .from("meta_ad_accounts")
    .select("id, ad_account_id, business_id, page_id, system_user_token, currency")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (acctErr) return json({ error: `ad account lookup: ${acctErr.message}` }, 500);
  if (!acctRow) {
    await flagFailed(campaignId, "no active meta_ad_accounts row");
    return json({ error: "no active ad account" }, 200);
  }
  const acct = acctRow as AdAccount;
  const token = acct.system_user_token;

  // Mark in-flight.
  await supabase
    .from("boost_campaigns")
    .update({ meta_sync_status: "creating", meta_sync_error: null })
    .eq("id", campaignId);

  // Destination: the pre-built profile/private-link URL (with UTM), else the
  // bare profile subdomain. Not resolve_boost_campaign_id (per spec).
  const destination = c.utm_url || (slug ? `https://${slug}.sqrz.com` : null);
  if (!destination) {
    await flagFailed(campaignId, "no destination URL (missing utm_url and profile slug)");
    return json({ error: "no destination" }, 200);
  }

  // Creative copy with safe fallbacks (only creative_asset_url is guaranteed).
  const campaignName = c.name?.trim() || `${displayName} — SQRZ`;
  const headline = c.headline?.trim() || displayName;
  const primaryText = c.primary_text?.trim() || c.notes?.trim() || `Discover ${displayName} on SQRZ.`;
  const description = c.description?.trim() || undefined;
  const objective = objectiveFor(c.goal);
  const cta = ctaFor(c.cta_type);

  // Track created objects for rollback (reverse order on failure).
  const created: { campaign?: string; adset?: string; creative?: string; ad?: string } = {};

  try {
    const resolvedPageId = await resolvePageId(acct);

    // 1) Media
    const isVideo = isVideoUrl(c.creative_asset_url);
    let imageHash: string | undefined;
    let videoId: string | undefined;
    let videoThumb: string | null = null;
    if (isVideo) {
      const v = await uploadVideo(acct, c.creative_asset_url);
      videoId = v.videoId;
      videoThumb = v.thumbnailUrl;
    } else {
      imageHash = await uploadImage(acct, c.creative_asset_url);
    }

    // 2) Campaign (PAUSED, no special ad category applies but the field is required)
    //
    // is_adset_budget_sharing_enabled: false — confirmed required by Meta as of
    // this API version whenever the campaign has no campaign-level (CBO) budget
    // (subcode 4834011 otherwise: "Must specify True or False ... if you are
    // not using campaign budget"). SQRZ's model is individual ad-set-level
    // budgets (campaign_budgets.allocated_cents per campaign, no shared pool),
    // so this is always false, never a per-campaign choice.
    const campaignRes = await metaPost(`${acct.ad_account_id}/campaigns`, token, {
      name: campaignName,
      objective,
      status: "PAUSED",
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    });
    created.campaign = campaignRes.id as string;

    // 3) Ad Set — lifetime_budget floor, worldwide + Advantage+, automatic placements
    const days = campaignDays(c.starts_at, c.ends_at);
    const minDaily = await minDailyBudgetCents(acct);
    const floorLifetime = minDaily * days;
    const startTime = c.starts_at ? new Date(c.starts_at).toISOString() : new Date().toISOString();
    const endTime = c.ends_at
      ? new Date(c.ends_at).toISOString()
      : new Date(Date.now() + days * 86_400_000).toISOString();

    const adsetRes = await metaPost(`${acct.ad_account_id}/adsets`, token, {
      name: `${campaignName} — Ad Set`,
      campaign_id: created.campaign,
      status: "PAUSED",
      billing_event: "IMPRESSIONS",
      // Fully automatic bidding: no bid amount / ROAS floor, matching SQRZ's
      // Advantage+ V1 posture where users do not manage ad-tech controls.
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      optimization_goal: optimizationGoalFor(objective),
      lifetime_budget: String(floorLifetime),
      start_time: startTime,
      end_time: endTime,
      // Meta requires the ad set to declare who's being promoted (subcode
      // 3858081, "No advertiser indicated" otherwise) — every ad this app
      // creates is Page-anchored (object_story_spec.page_id below), so
      // page_id is the correct shape for all three objectives SQRZ uses
      // (OUTCOME_TRAFFIC/AWARENESS/ENGAGEMENT), not just LINK_CLICKS.
      // Confirmed against the live API: omitting this fails with 3858081
      // regardless of bid_strategy being present; adding it clears that
      // error entirely.
      promoted_object: { page_id: resolvedPageId },
      targeting: {
        geo_locations: { location_types: ["home", "recent"], country_groups: ["worldwide"] },
        targeting_automation: { advantage_audience: 1 },
      },
    });
    created.adset = adsetRes.id as string;

    // 4) Ad Creative — page identity + link/video content + CTA + destination
    const callToAction = { type: cta, value: { link: destination } };
    const objectStorySpec = isVideo
      ? {
          page_id: resolvedPageId,
          video_data: {
            video_id: videoId,
            message: primaryText,
            title: headline,
            link_description: description,
            call_to_action: { ...callToAction, value: { ...callToAction.value, link_title: headline } },
            ...(videoThumb ? { image_url: videoThumb } : {}),
          },
        }
      : {
          page_id: resolvedPageId,
          link_data: {
            message: primaryText,
            link: destination,
            name: headline,
            ...(description ? { description } : {}),
            image_hash: imageHash,
            call_to_action: callToAction,
          },
        };

    const creativeRes = await metaPost(`${acct.ad_account_id}/adcreatives`, token, {
      name: `${campaignName} — Creative`,
      object_story_spec: objectStorySpec,
      // Opt into Advantage+ creative standard enhancements is left off in V1
      // (deterministic creative); can be added later.
    });
    created.creative = creativeRes.id as string;

    // 5) Ad (PAUSED)
    const adRes = await metaPost(`${acct.ad_account_id}/ads`, token, {
      name: campaignName,
      adset_id: created.adset,
      creative: { creative_id: created.creative },
      status: "PAUSED",
    });
    created.ad = adRes.id as string;

    // Store ids back + mark created.
    await supabase
      .from("boost_campaigns")
      .update({
        meta_campaign_id: created.campaign,
        meta_adset_id: created.adset,
        meta_ad_id: created.ad,
        meta_sync_status: "created",
        meta_sync_error: null,
        meta_synced_at: new Date().toISOString(),
      })
      .eq("id", campaignId);

    return json({
      ok: true,
      campaign_id: campaignId,
      meta_campaign_id: created.campaign,
      meta_adset_id: created.adset,
      meta_ad_id: created.ad,
      meta_creative_id: created.creative,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[meta-campaign-create] ${campaignId} failed:`, message);

    // Rollback in reverse creation order so no orphaned chain is left behind.
    if (created.ad) await metaDelete(created.ad, token);
    if (created.creative) await metaDelete(created.creative, token);
    if (created.adset) await metaDelete(created.adset, token);
    if (created.campaign) await metaDelete(created.campaign, token);

    await flagFailed(campaignId, message);
    return json({ error: message, rolled_back: created }, 200);
  }
});

async function flagFailed(campaignId: string, detail: string): Promise<void> {
  await supabase
    .from("boost_campaigns")
    .update({
      meta_sync_status: "failed",
      // Cap the detail so a huge Meta error body can't bloat the row.
      meta_sync_error: detail.slice(0, 1000),
    })
    .eq("id", campaignId);
}
