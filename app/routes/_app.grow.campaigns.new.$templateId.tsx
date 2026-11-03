import { useState } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app.grow.campaigns.new.$templateId";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { pageContainerStyle } from "~/components/PageContainer";
import { requirePro } from "~/lib/pro.server";
import { getActiveProfile } from "~/lib/profile.server";
import { isWebCampaignCreateEnabled } from "~/lib/flags.server";
import { supabase as browserSupabase } from "~/lib/supabase.client";
import LocationPicker, { type CampaignLocation } from "~/components/LocationPicker";
import {
  type CampaignLite,
  type CampaignTemplate,
  CREATIVE_FORMATS,
  CTA_TYPES,
  RADIUS_OPTIONS_KM,
  extractYouTubeVideoId,
  normalizedYouTubeUrl,
  opensManagedCall,
  prefilledBookingUrl,
  proIncludedText,
  requiresBudgetInput,
  templateAvailability,
} from "~/lib/templates";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // same 50 MB limit as iOS

type ExistingPost = {
  source: string; id: string;
  message?: string | null; full_picture?: string | null; permalink_url?: string | null; created_time?: string | null;
  caption?: string | null; media_url?: string | null; thumbnail_url?: string | null; permalink?: string | null; timestamp?: string | null;
  eligible?: boolean | null; ineligible_reason?: string | null;
};

// ─── Loader ───────────────────────────────────────────────────────────────────
// Create a campaign from a template. Same template rules as the Grow tab cards
// (coming soon / unlock rule / non-Meta outlet → back to Grow). Same tables as
// iOS: campaign_templates, private_booking_links, profile_meta_connections, and
// the meta-page-posts edge function for the existing-post picker.
async function loadTemplateAndProfile(request: Request, templateId: string) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw redirect("/login", { headers });
  await requirePro(supabase, user.id, headers);
  // Web campaign creation is switched by app_config.web_campaign_create_enabled
  // (default off). Checked here so BOTH the loader and the action are unreachable
  // by URL when it is false.
  if (!(await isWebCampaignCreateEnabled(supabase))) throw redirect("/grow", { headers });
  const profile = await getActiveProfile(request, supabase, user.id);
  if (!profile) throw redirect("/login", { headers });

  const [{ data: template }, { data: camps }] = await Promise.all([
    supabase.from("campaign_templates").select("*").eq("id", templateId).maybeSingle(),
    supabase.from("boost_campaigns").select("campaign_template, status").eq("profile_id", profile.id as string),
  ]);
  const t = template as CampaignTemplate | null;
  if (!t || templateAvailability(t, (camps ?? []) as CampaignLite[]).kind !== "open") {
    throw redirect("/grow", { headers });
  }
  return { supabase, headers, user, profile, t };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers, profile, t } = await loadTemplateAndProfile(request, params.templateId);
  const profileId = profile.id as string;

  const { data: links } = await supabase
    .from("private_booking_links")
    .select("id, title, link_slug")
    .eq("profile_id", profileId)
    .eq("is_active", true)
    .eq("page_type", "internal")
    .order("created_at", { ascending: false });

  // Existing-post picker (existing_post templates, or the optional "use an
  // existing post" for upload templates) needs an active Facebook Page connection.
  const { data: conn } = await supabase
    .from("profile_meta_connections")
    .select("page_name, status")
    .eq("profile_id", profileId)
    .eq("status", "active")
    .maybeSingle();

  let posts: ExistingPost[] = [];
  let postsError: string | null = null;
  if (conn && !opensManagedCall(t)) {
    const { data, error } = await supabase.functions.invoke("meta-page-posts", { body: { profile_id: profileId } });
    if (error) postsError = "Couldn't load your posts right now.";
    else posts = (data?.posts ?? []) as ExistingPost[];
  }

  return Response.json(
    {
      template: t,
      profileId,
      supabaseUrl: process.env.SUPABASE_URL ?? "",
      links: links ?? [],
      pageName: (conn as { page_name: string | null } | null)?.page_name ?? null,
      hasConnection: !!conn,
      posts,
      postsError,
    },
    { headers }
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────
type Payload = {
  campaignId: string;
  name: string;
  promoteType: "profile" | "link";
  promoteLinkId: string | null;
  location: CampaignLocation | null;
  targetAudience: string;
  budgetDollars: number | null;
  freeBudgetText: string;
  endChoice: "date" | "budget";
  endDate: string | null;
  goals: string;
  creative: {
    source: "upload" | "existing_post" | "video_link";
    assetUrl: string | null;
    existingPostId: string | null;
    existingPostSource: string | null;
    videoUrl: string;
    videoConfirmed: boolean;
    format: string | null;
    ctaType: string | null;
    primaryText: string;
    headline: string;
    description: string;
  };
};

const fail = (message: string, headers: Headers) => Response.json({ ok: false, error: message }, { status: 400, headers });

export async function action({ request, params }: Route.ActionArgs) {
  const { supabase, headers, profile, t } = await loadTemplateAndProfile(request, params.templateId);
  const profileId = profile.id as string;
  const slug = profile.slug as string;

  let p: Payload;
  try {
    p = JSON.parse(String((await request.formData()).get("payload") ?? ""));
  } catch {
    return fail("Invalid request.", headers);
  }

  const isRequest = opensManagedCall(t);
  const name = (p.name ?? "").trim();
  if (!name) return fail("Enter a campaign name.", headers);

  // Location is required (iOS: canSubmit requires `location`).
  const loc = p.location;
  if (!loc || !loc.cityName || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude) || !(RADIUS_OPTIONS_KM as readonly number[]).includes(loc.radiusKm)) {
    return fail("Choose a location.", headers);
  }

  // Destination: only when the template allows a choice; a link must be one of the profile's own internal links.
  let promoteType: "profile" | "link" = "profile";
  let promoteLinkId: string | null = null;
  if (t.allow_destination_choice && p.promoteType === "link") {
    promoteType = "link";
    const { data: link } = await supabase
      .from("private_booking_links").select("id").eq("id", p.promoteLinkId ?? "").eq("profile_id", profileId).eq("page_type", "internal").maybeSingle();
    if (!link) return fail("Select a link to promote.", headers);
    promoteLinkId = link.id as string;
  }

  const audience = (p.targetAudience ?? "").trim();
  const today = new Date().toISOString().slice(0, 10);
  const utmUrl = `https://${slug}.sqrz.com?utm_source=sqrz_boost&utm_medium=paid&utm_campaign=boost_${slug}`;
  const base = {
    profile_id: profileId,
    name,
    promote_type: promoteType,
    promote_link_id: promoteLinkId,
    channels: ["meta"], // boost_campaigns_channels_check allows only meta for campaign_type 'boost'
    campaign_template: t.id,
    target_audience: audience || null,
    budget_currency: "USD",
    campaign_type: "boost",
    utm_url: utmUrl,
    starts_at: today,
    location_city: loc.cityName,
    location_latitude: loc.latitude,
    location_longitude: loc.longitude,
    location_radius_km: loc.radiusKm,
  };

  // ── Contact templates: request mode — saved as a managed request (pending),
  // no payment; the artist then books the intake call (HubSpot).
  if (isRequest) {
    let amount = 0;
    if (requiresBudgetInput(t)) {
      amount = t.budget_options?.length ? Number(p.budgetDollars ?? 0) : Number(p.freeBudgetText);
      if (!Number.isFinite(amount) || amount <= 0) return fail("Enter an ad budget.", headers);
      if (t.budget_options?.length && !t.budget_options.includes(amount)) return fail("Choose a budget.", headers);
      if (t.ad_budget_min != null && amount < t.ad_budget_min) return fail(`Minimum budget is $${t.ad_budget_min}.`, headers);
    }
    const goals = (p.goals ?? "").trim();
    const { data, error } = await supabase
      .from("boost_campaigns")
      .insert({ ...base, status: "pending", is_managed: true, notes: goals || null, budget_amount: amount })
      .select("id")
      .single();
    if (error || !data) return fail("Could not send your request.", headers);
    return Response.json(
      { ok: true, kind: "request", campaignId: data.id, bookingUrl: prefilledBookingUrl(profile as never) },
      { headers }
    );
  }

  // ── Self-serve: validate like iOS (canSubmit + canLaunchWithActivation) ──
  if (!UUID_RE.test(p.campaignId ?? "")) return fail("Invalid request.", headers);
  const dollars = Number(p.budgetDollars);
  if (!Number.isFinite(dollars) || dollars <= 0 || !t.budget_options?.includes(dollars)) return fail("Choose an ad budget.", headers);
  const totalCents = Math.round(dollars * 100);

  let endMode: "date" | "budget";
  let endsAt: string | null = null;
  let dailyBudgetCents: number | null = null;
  if (p.endChoice === "date" && t.end_options.includes("date")) {
    const when = p.endDate ? Date.parse(p.endDate) : NaN;
    if (!Number.isFinite(when) || when <= Date.now()) return fail("Choose an end date in the future.", headers);
    endMode = "date";
    endsAt = new Date(when).toISOString();
  } else if (p.endChoice === "budget" && t.end_options.includes("budget")) {
    endMode = "budget";
    dailyBudgetCents = Math.round(totalCents / 7); // same rule as iOS: total ÷ 7
    if (dailyBudgetCents <= 0) return fail("Choose an ad budget.", headers);
  } else {
    return fail("Choose how the campaign ends.", headers);
  }

  // Creative (iOS BoostContentSheet.canSubmit). Status stays 'booked' — payment is done in the app.
  const c = p.creative;
  const forcedExistingPost = t.creative_source === "existing_post";
  const isVideoTemplate = t.creative_source === "video_link";
  let creative: Record<string, unknown>;

  if (forcedExistingPost) {
    if (!c?.existingPostId) return fail("Choose a post to promote.", headers);
    creative = {
      creative_asset_url: null, existing_post_id: c.existingPostId, existing_post_source: c.existingPostSource === "instagram" ? "instagram" : "facebook",
      video_link_url: null, creative_format: null, primary_text: null, headline: null, description: null, cta_type: null,
    };
  } else {
    const primaryText = (c?.primaryText ?? "").trim();
    const headline = (c?.headline ?? "").trim();
    if (!c?.format || !(CREATIVE_FORMATS as readonly string[]).includes(c.format)) return fail("Choose a format.", headers);
    if (!c?.ctaType || !(CTA_TYPES as readonly string[]).includes(c.ctaType)) return fail("Choose a call to action.", headers);
    if (!primaryText) return fail("Write your message.", headers);
    if (!headline) return fail("Write a headline.", headers);

    let assetUrl: string | null = null;
    let existingPostId: string | null = null;
    let existingPostSource: string | null = null;
    let videoUrl: string | null = null;

    if (isVideoTemplate) {
      const id = extractYouTubeVideoId(c.videoUrl ?? "");
      if (!id || !c.videoConfirmed) return fail("Paste a YouTube link and confirm the video.", headers);
      videoUrl = normalizedYouTubeUrl(id);
    } else if (c.source === "existing_post") {
      if (!c.existingPostId) return fail("Choose a post to promote.", headers);
      existingPostId = c.existingPostId;
      existingPostSource = c.existingPostSource === "instagram" ? "instagram" : "facebook";
    } else {
      // The upload must live in THIS profile's folder of the campaign-creative bucket.
      const prefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/campaign-creative/${profileId.toLowerCase()}/${p.campaignId.toLowerCase()}.`;
      if (!c.assetUrl || !c.assetUrl.startsWith(prefix)) return fail("Upload an image or video.", headers);
      assetUrl = c.assetUrl;
    }
    creative = {
      creative_asset_url: assetUrl, existing_post_id: existingPostId, existing_post_source: existingPostSource, video_link_url: videoUrl,
      creative_format: c.format, primary_text: primaryText, headline, description: (c.description ?? "").trim() || null, cta_type: c.ctaType,
    };
  }

  const { data, error } = await supabase
    .from("boost_campaigns")
    .insert({
      id: p.campaignId,
      ...base,
      status: "booked", // the pre-payment state iOS also saves before the in-app purchase
      budget_amount: dollars, // persisted like iOS — the app reads it back to fund the campaign
      end_mode: endMode,
      ends_at: endsAt,
      daily_budget_cents: dailyBudgetCents,
      ...creative,
    })
    .select("id")
    .single();
  if (error || !data) return fail("Could not create the campaign.", headers);

  return Response.json({ ok: true, kind: "self_serve", campaignId: data.id }, { headers });
}

// ─── UI ──────────────────────────────────────────────────────────────────────
const input: React.CSSProperties = {
  width: "100%", padding: "12px 14px", background: "var(--surface)", border: "1px solid var(--border)",
  borderRadius: 10, fontSize: 14, color: "var(--text)", outline: "none", boxSizing: "border-box", fontFamily: FONT_BODY,
};

function Group({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.06em", color: ACCENT, marginBottom: 8 }}>{title}</div>
      {children}
      {hint && <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{hint}</p>}
    </div>
  );
}

function Pill({ label, selected, onClick, disabled }: { label: string; selected: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      style={{
        padding: "8px 14px", borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: disabled ? "default" : "pointer",
        border: `1px solid ${selected ? ACCENT : "var(--border)"}`,
        background: selected ? "rgba(245,166,35,0.12)" : "var(--surface)", color: selected ? ACCENT : "var(--text)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

const pills: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };
const labelFor = (s: string) => s.replace("_", " ").replace(/^./, (c) => c.toUpperCase());

function PostPicker({ posts, source, requireEligible, selectedId, onSelect }: {
  posts: ExistingPost[]; source: string | null; requireEligible: boolean; selectedId: string | null; onSelect: (p: ExistingPost) => void;
}) {
  const list = posts.filter((p) => !source || p.source === source);
  if (list.length === 0) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>No posts found on your connected Page.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflowY: "auto" }}>
      {list.map((p) => {
        const ig = p.source === "instagram";
        const text = (ig ? p.caption : p.message) ?? "";
        const img = ig ? p.thumbnail_url || p.media_url : p.full_picture;
        const blocked = requireEligible && p.eligible === false;
        const selected = selectedId === p.id;
        return (
          <button
            key={`${p.source}-${p.id}`} type="button" disabled={blocked} onClick={() => onSelect(p)}
            style={{
              display: "flex", gap: 12, textAlign: "left", padding: 10, borderRadius: 10, cursor: blocked ? "default" : "pointer",
              border: `1px solid ${selected ? ACCENT : "var(--border)"}`, background: selected ? "rgba(245,166,35,0.08)" : "var(--surface)",
              opacity: blocked ? 0.5 : 1, color: "var(--text)",
            }}
          >
            {img ? <img src={img} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} /> : <div style={{ width: 56, height: 56, borderRadius: 8, background: "var(--surface-muted)", flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT }}>{ig ? "Instagram" : "Facebook"}</div>
              <div style={{ fontSize: 13, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{text || "(no text)"}</div>
              {blocked && <div style={{ fontSize: 11, color: "#ef4444" }}>{p.ineligible_reason || "Not eligible for ads"}</div>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export default function NewCampaign() {
  const { template: t, profileId, supabaseUrl, links, pageName, hasConnection, posts, postsError } =
    useLoaderData<typeof loader>() as unknown as {
      template: CampaignTemplate; profileId: string; supabaseUrl: string; links: Array<{ id: string; title: string; link_slug: string }>;
      pageName: string | null; hasConnection: boolean; posts: ExistingPost[]; postsError: string | null;
    };
  const fetcher = useFetcher<{ ok: boolean; error?: string; kind?: string; campaignId?: string; bookingUrl?: string }>();
  const isRequest = opensManagedCall(t);
  const forcedExistingPost = t.creative_source === "existing_post";
  const isVideoTemplate = t.creative_source === "video_link";
  const pro = proIncludedText(t);

  const [campaignId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [promoteType, setPromoteType] = useState<"profile" | "link">("profile");
  const [promoteLinkId, setPromoteLinkId] = useState("");
  const [budgetDollars, setBudgetDollars] = useState<number | null>(null);
  const [freeBudgetText, setFreeBudgetText] = useState("");
  const [endChoice, setEndChoice] = useState<"date" | "budget">(t.end_options.includes("budget") ? "budget" : "date");
  const [endDate, setEndDate] = useState("");
  const [location, setLocation] = useState<CampaignLocation | null>(null);
  const [targetAudience, setTargetAudience] = useState("");
  const [goals, setGoals] = useState("");
  const [source, setSource] = useState<"upload" | "existing_post">(forcedExistingPost ? "existing_post" : "upload");
  const [file, setFile] = useState<File | null>(null);
  const [post, setPost] = useState<ExistingPost | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoConfirmed, setVideoConfirmed] = useState(false);
  const [format, setFormat] = useState<string | null>(null);
  const [ctaType, setCtaType] = useState<string | null>(null);
  const [primaryText, setPrimaryText] = useState("");
  const [headline, setHeadline] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  const busy = uploading || fetcher.state !== "idle";
  const videoId = extractYouTubeVideoId(videoUrl);
  const result = fetcher.data;
  const created = result?.ok ? result : null;

  async function submit() {
    setError("");
    let assetUrl: string | null = null;

    if (!isRequest && !forcedExistingPost && !isVideoTemplate && source === "upload") {
      if (!file) { setError("Upload an image or video."); return; }
      if (file.size > MAX_UPLOAD_BYTES) { setError("File must be under 50 MB."); return; }
      setUploading(true);
      // Same bucket and path convention as iOS: campaign-creative/{profileId}/{campaignId}.{ext}, both lowercased
      // (storage RLS compares the first path segment to the lowercase profile id). Uploaded from the browser
      // (not through the server) so large videos don't hit the serverless request-size limit.
      const ext = (file.name.split(".").pop() || (file.type.startsWith("video") ? "mp4" : "jpg")).toLowerCase();
      const path = `${profileId.toLowerCase()}/${campaignId.toLowerCase()}.${ext}`;
      const { error: upErr } = await browserSupabase.storage.from("campaign-creative").upload(path, file, { contentType: file.type || undefined, upsert: true });
      setUploading(false);
      if (upErr) { setError(upErr.message); return; }
      const { data } = browserSupabase.storage.from("campaign-creative").getPublicUrl(path);
      assetUrl = `${data.publicUrl}?v=${Date.now()}`;
    }

    const payload: Payload = {
      campaignId, name, promoteType, promoteLinkId: promoteType === "link" ? promoteLinkId : null, location, targetAudience,
      budgetDollars, freeBudgetText, endChoice, endDate: endDate ? new Date(endDate).toISOString() : null, goals,
      creative: {
        source: forcedExistingPost || source === "existing_post" ? "existing_post" : isVideoTemplate ? "video_link" : "upload",
        assetUrl, existingPostId: post?.id ?? null, existingPostSource: post?.source ?? null,
        videoUrl, videoConfirmed, format, ctaType, primaryText, headline, description,
      },
    };
    fetcher.submit({ payload: JSON.stringify(payload) }, { method: "post" });
  }

  // ── Done screens ──
  if (created?.kind === "request") {
    return (
      <div style={pageContainerStyle}>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 30, color: ACCENT, textTransform: "uppercase", margin: "0 0 12px" }}>Request sent</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6 }}>Your campaign request is saved. Book your call with SQRZ to set it up — wire-transfer details are discussed on the call.</p>
        <a href={created.bookingUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", margin: "12px 0", padding: "12px 22px", background: ACCENT, color: "#111", fontWeight: 700, borderRadius: 10, textDecoration: "none" }}>
          Book your call →
        </a>
        <div><Link to="/grow?tab=campaigns" style={{ color: ACCENT, fontSize: 14 }}>View my campaigns</Link></div>
      </div>
    );
  }
  if (created?.kind === "self_serve") {
    return (
      <div style={pageContainerStyle}>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 30, color: ACCENT, textTransform: "uppercase", margin: "0 0 12px" }}>Campaign saved</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6 }}>
          <strong>Complete payment in the SQRZ app</strong> to start this campaign. It's waiting for you under "Needs action".
        </p>
        <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
          <Link to={`/grow/campaigns/${created.campaignId}`} style={{ color: ACCENT, fontSize: 14, fontWeight: 700 }}>View campaign</Link>
          <Link to="/grow?tab=campaigns" style={{ color: "var(--text-muted)", fontSize: 14 }}>All campaigns</Link>
        </div>
      </div>
    );
  }

  const needsConnection = (forcedExistingPost && t.requires_connected_page) || (source === "existing_post" && !forcedExistingPost);
  const showCreative = !isRequest;

  return (
    <div style={pageContainerStyle}>
      <Link to="/grow" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Grow</Link>
      <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800, color: ACCENT, textTransform: "uppercase", margin: "12px 0 4px", lineHeight: 1.05 }}>{t.name}</h1>
      {t.subtitle && <p style={{ margin: "0 0 4px", fontSize: 14, color: "var(--text-muted)" }}>{t.subtitle}</p>}
      {pro && <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 700, color: ACCENT }}>{pro}</p>}
      <p style={{ margin: "0 0 24px", fontSize: 12, color: "var(--text-muted)" }}>
        {isRequest ? "Tell us about your campaign — you'll book an intake call next. No payment on the web." : "Payment is completed in the SQRZ app after you save."}
      </p>

      <Group title="CAMPAIGN NAME">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Summer Tour Promo" style={input} />
      </Group>

      {t.allow_destination_choice && (
        <Group title="WHAT DO YOU WANT TO PROMOTE?">
          <div style={pills}>
            <Pill label="My Profile" selected={promoteType === "profile"} onClick={() => { setPromoteType("profile"); setPromoteLinkId(""); }} />
            <Pill label="A Private Link" selected={promoteType === "link"} onClick={() => setPromoteType("link")} />
          </div>
          {promoteType === "link" && (
            <select value={promoteLinkId} onChange={(e) => setPromoteLinkId(e.target.value)} style={{ ...input, marginTop: 10 }}>
              <option value="">Select a link…</option>
              {links.map((l) => <option key={l.id} value={l.id}>{l.title || l.link_slug}</option>)}
            </select>
          )}
        </Group>
      )}

      {(isRequest ? requiresBudgetInput(t) : true) && (
        <Group title="AD BUDGET" hint={isRequest ? "We'll follow up with specifics on your call." : "Paid separately, right after activation."}>
          {t.budget_options?.length ? (
            <div style={pills}>
              {t.budget_options.map((d) => <Pill key={d} label={`$${d}`} selected={budgetDollars === d} onClick={() => setBudgetDollars(d)} />)}
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input value={freeBudgetText} onChange={(e) => setFreeBudgetText(e.target.value)} inputMode="numeric" placeholder="Amount" style={{ ...input, maxWidth: 140 }} />
              {t.ad_budget_min != null && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Minimum ${t.ad_budget_min}</span>}
            </div>
          )}
        </Group>
      )}

      {!isRequest && (
        <Group title="END">
          <div style={pills}>
            {t.end_options.includes("budget") && <Pill label="When the budget is used up" selected={endChoice === "budget"} onClick={() => setEndChoice("budget")} />}
            {t.end_options.includes("date") && <Pill label="On a date" selected={endChoice === "date"} onClick={() => setEndChoice("date")} />}
          </div>
          {endChoice === "date" && (
            <input type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ ...input, marginTop: 10, maxWidth: 260 }} />
          )}
        </Group>
      )}

      <Group title="LOCATION"><LocationPicker value={location} onChange={setLocation} /></Group>

      <Group title="WHO IS YOUR TARGET AUDIENCE?" hint="Describe your ideal client in plain language — we handle the targeting.">
        <textarea value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} rows={3} placeholder="e.g. Club promoters in Berlin, Festival organizers in France" style={{ ...input, resize: "vertical" }} />
      </Group>

      {isRequest && (
        <Group title="TELL US ABOUT YOUR GOALS">
          <textarea value={goals} onChange={(e) => setGoals(e.target.value)} rows={3} placeholder="What are you trying to achieve with this campaign?" style={{ ...input, resize: "vertical" }} />
        </Group>
      )}

      {showCreative && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, margin: "8px 0 14px" }}>Creative</div>

          {!forcedExistingPost && !isVideoTemplate && hasConnection && (
            <Group title="SOURCE">
              <div style={pills}>
                <Pill label="Upload" selected={source === "upload"} onClick={() => setSource("upload")} />
                <Pill label="Use an existing post" selected={source === "existing_post"} onClick={() => setSource("existing_post")} />
              </div>
            </Group>
          )}

          {isVideoTemplate ? (
            <Group title="YOUTUBE VIDEO">
              <input value={videoUrl} onChange={(e) => { setVideoUrl(e.target.value); setVideoConfirmed(false); }} placeholder="Paste a YouTube link" style={input} />
              {videoId && (
                <div style={{ marginTop: 10 }}>
                  <img src={`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`} alt="Video thumbnail" style={{ maxWidth: "100%", borderRadius: 10, display: "block" }} />
                  <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={videoConfirmed} onChange={(e) => setVideoConfirmed(e.target.checked)} /> Yes, promote this video
                  </label>
                </div>
              )}
            </Group>
          ) : forcedExistingPost || source === "existing_post" ? (
            <Group title="CHOOSE A POST" hint={pageName ? `From your connected Page: ${pageName}` : undefined}>
              {!hasConnection ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                  {needsConnection ? "Connect your Facebook Page in the SQRZ app (Business) to promote an existing post." : "No Facebook Page connected."}
                </p>
              ) : postsError ? (
                <p style={{ fontSize: 13, color: "#ef4444", margin: 0 }}>{postsError}</p>
              ) : (
                <PostPicker posts={posts} source={forcedExistingPost ? t.post_source : null} requireEligible={t.requires_eligibility_check} selectedId={post?.id ?? null} onSelect={setPost} />
              )}
            </Group>
          ) : (
            <Group title="CREATIVE" hint="Image or video, max 50 MB.">
              <input type="file" accept="image/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: 13 }} />
              {file && <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
            </Group>
          )}

          {!forcedExistingPost && (
            <>
              <Group title="FORMAT">
                <div style={pills}>{CREATIVE_FORMATS.map((f) => <Pill key={f} label={labelFor(f)} selected={format === f} onClick={() => setFormat(f)} />)}</div>
              </Group>
              <Group title="WRITE YOUR MESSAGE">
                <textarea value={primaryText} onChange={(e) => setPrimaryText(e.target.value)} rows={3} style={{ ...input, resize: "vertical" }} />
              </Group>
              <Group title="HEADLINE"><input value={headline} onChange={(e) => setHeadline(e.target.value)} style={input} /></Group>
              <Group title="DESCRIPTION (OPTIONAL)"><input value={description} onChange={(e) => setDescription(e.target.value)} style={input} /></Group>
              <Group title="CALL TO ACTION">
                <div style={pills}>{CTA_TYPES.map((c) => <Pill key={c} label={labelFor(c)} selected={ctaType === c} onClick={() => setCtaType(c)} />)}</div>
              </Group>
            </>
          )}
        </>
      )}

      {(error || (fetcher.data && !fetcher.data.ok)) && (
        <p role="alert" style={{ color: "#ef4444", fontSize: 13, margin: "0 0 12px" }}>{error || fetcher.data?.error}</p>
      )}

      <button
        type="button" onClick={submit} disabled={busy}
        style={{ width: "100%", padding: 14, background: ACCENT, color: "#111", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
      >
        {uploading ? "Uploading…" : fetcher.state !== "idle" ? "Saving…" : isRequest ? "Request campaign →" : "Save campaign"}
      </button>
      {!isRequest && <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>You'll complete payment in the SQRZ app.</p>}
    </div>
  );
}
