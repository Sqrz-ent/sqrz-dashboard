import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { gatherCampaignInsights, type CampaignInsights } from "../_shared/campaign-insights.ts";

// ─────────────────────────────────────────────────────────────────────────────
// profile-advisor — goal-to-template advisor (2026-11 rework). Takes the
// artist's own free-text goal (user_goal) and recommends 1-3 campaign
// templates from the live catalog that fit it, rather than producing a
// general profile-health report. Still absorbs campaign-advisor's
// per-campaign data gathering (see _shared/campaign-insights.ts) as
// supporting context — campaign-advisor and campaign_advisor_runs remain
// untouched (unused; removal decided later).
//
// Input:  { profile_id: uuid, access_token: string, user_goal: string } —
//         profile_id is resolved and owns-checked by the forwarder BEFORE
//         invoking this function (see the Identity note in the handler below
//         for why this function cannot verify a Bearer token for the
//         SERVICE-ROLE invoke call itself); access_token is the caller's own
//         real session token, passed through separately so the Lab-only
//         check below can run as that specific user. user_goal is required
//         free text (max 500 chars) — what the artist wants to achieve, in
//         their own words.
// Output: { user_goal, summary, recommendations: [{ template_id, reason }] }
//         (1-3 items) — replaces the old { health, summary, insights, actions }
//         shape entirely.
//
// Context for the recommendation: the artist's profile (name/city/bio,
// stated Dashboard goal), their organic vs. campaign traffic (the
// profile_analytics view), every campaign they've already run (template/
// status/budget/Meta-insights/funnel, plus — where one exists — that
// campaign's own already-stored campaign_advisor_runs verdict, reused as-is),
// and the full live template catalog (every non-hidden campaign_templates
// row, read with the service role so the model sees every outlet regardless
// of the caller's own RLS visibility). All of this is supporting context
// ONLY — user_goal is what actually drives which templates get recommended.
//
// Access: Lab-only (2026-11) — public.caller_account_is_lab(), called with
// the caller's own JWT (same pattern as sandbox-admin). Not lab → 403.
//
// Rate limit: SAME rule for everyone — no RevenueCat/grow_access check at
// all, paid and invite-code users are treated identically. A profile with no
// ACTIVATED campaign (status 'live' or 'completed' — i.e. launched at least
// once; see the handler below for the exact query) gets ONE run per calendar
// week, reset every Monday 00:00 UTC. Once a profile has had at least one
// activated campaign, runs are unlimited. Checked against profile_advisor_runs
// itself — no separate "last run" column anywhere.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ─── Types ──────────────────────────────────────────────────────────────────

// Still needed to decode a campaign's OWN already-stored verdict below —
// campaign-advisor itself (and campaign_advisor_runs' row shape) is
// untouched by this rework.
type AdvisorHealth = "excellent" | "good" | "mixed" | "needs_attention";

// A template recommendation — the new output shape (replaces the old
// health/summary/insights/actions profile-health report entirely).
type TemplateRecommendation = {
  template_id: string;
  reason: string;
};

type AdvisorResult = {
  user_goal: string;
  summary: string;
  recommendations: TemplateRecommendation[];
};

// A campaign's own already-computed verdict, reused as-is when present.
// Deliberately NOT the full AdvisorResult shape — only what's useful as
// context for the template-recommendation model, to keep the payload small.
type CampaignAdvisorSnapshot = {
  health: AdvisorHealth;
  summary: string;
  top_action: string | null;
};

// CampaignInsights (id/template/status/dates/budget/meta_stats/funnel) is the
// same per-campaign shape campaign-advisor gathers — see
// _shared/campaign-insights.ts. template is resolved via effectiveTemplate
// there, distinct from profiles.goal below.
type ProfileAdvisorCampaign = CampaignInsights & {
  // Present only when this campaign has already been analyzed individually
  // (campaign_advisor_runs has a row for it). null, not fabricated, otherwise.
  latest_advisor_result: CampaignAdvisorSnapshot | null;
};

// One campaign_templates row, as sent to the model (2026-11) — the live
// catalog the recommendation is drawn from. Read with the service role so
// every outlet is visible regardless of the caller's own RLS visibility
// (e.g. beta-only rows). status = 'hidden' rows are excluded entirely.
type TemplateCatalogEntry = {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  long_description: string | null;
  display_price: number | null;
  // Free-text jsonb, shape not enforced at the DB level (e.g. ["Instagram"],
  // ["Facebook","Instagram"]) — passed through as-is, same looseness as the
  // web dashboard's own CampaignTemplate type (lib/templates.ts).
  outlets: unknown;
  // 'meta' | 'other' — combined with delivery below to decide whether a
  // template can be bought directly (outlet='meta' AND delivery='self_serve')
  // or is a beta campaign Will sets up personally.
  outlet: string | null;
  delivery: string | null; // 'self_serve' | 'contact'
  ad_budget_min: number | null;
  ad_budget_max: number | null;
  pro_days: number | null;
};

type ProfileAdvisorPayload = {
  // What the artist typed, in their own words — the PRIMARY driver of which
  // templates get recommended. Everything else below is supporting context.
  user_goal: string;
  // profiles.goal — grow_views | get_booked | other | null (not chosen yet).
  // Secondary context only — distinct from user_goal above.
  goal: string | null;
  artist: {
    name: string | null;
    city: string | null;
    bio: string | null;
  };
  // From the profile_analytics view — the real organic/campaign split, NOT
  // the Dashboard's get_profile_analytics RPC (which lumps all traffic
  // together regardless of source).
  analytics: {
    organic_views: number;
    campaign_views: number;
    views_7d: number;
    views_prev_7d: number;
    unique_visitors_7d: number;
    total_views: number;
    total_unique_visitors: number;
    booking_modal_opens_7d: number;
    total_booking_modal_opens: number;
    chat_opens_7d: number;
    total_chat_opens: number;
  };
  // Whether the profile has any active bookable service right now. When
  // false, booking-related metrics must not be judged as a problem.
  services_active: boolean;
  // Every campaign the profile has ever run, oldest-agnostic (not just
  // recent/completed) — empty array for a profile with none, which is a
  // normal input, not an error state.
  campaigns: ProfileAdvisorCampaign[];
  // Every non-hidden campaign_templates row — what recommendations.template_id
  // must be drawn from.
  template_catalog: TemplateCatalogEntry[];
};

// ─── LLM boundary ─────────────────────────────────────────────────────────────
// getAdvisorRecommendation is the ONLY place any provider's API is called —
// same provider-swap pattern as campaign-advisor (ADVISOR_PROVIDERS keyed by
// the ADVISOR_PROVIDER env var; only "anthropic" exists today in either file).

const PROFILE_ADVISOR_SYSTEM_PROMPT = `You are a growth advisor for SQRZ, a booking platform for independent creative professionals (musicians, DJs, artists). The artist has described what they want to achieve in their own words — payload.user_goal. You receive one JSON payload with that goal, their profile, their traffic, every campaign they've already run, and the full live catalog of campaign templates (payload.template_catalog) — and must recommend 1 to 3 templates through the advisor_report tool that best fit user_goal.

Be concise.

user_goal drives the recommendation. Everything else in the payload (profile, analytics, campaigns, profiles.goal) is supporting context only — use it to tailor the reasons, never to override or second-guess what the artist actually asked for.

recommendations: 1 to 3 items, each { template_id, reason }.
- template_id MUST be an id that actually appears in payload.template_catalog. Never invent, guess, or remember an id from outside the payload.
- reason is ONE sentence explaining why this template fits user_goal (and, where relevant, the profile/campaign context) — and states the purchase route (see the rule below).
- Pick the smallest set (1-3) that genuinely covers the goal — do not pad to 3 if 1 or 2 is the honest answer.

Purchase route — every reason must make this plain, since it changes what the artist should expect to happen next:
- A template with outlet = "meta" AND delivery = "self_serve" can be started directly in the app right now — a real, one-tap self-serve purchase.
- Every other template (any other outlet, or delivery = "contact") is a beta campaign that Will sets up personally — say so plainly in the reason (e.g. "this one is set up personally by Will — worth booking a call") and encourage booking it. Never imply it's a one-tap or immediately-available in-app purchase.

Channel fit: prefer a template whose outlet is NOT "meta" (a contact/managed template) whenever user_goal genuinely needs a channel Meta can't serve — e.g. the goal explicitly mentions YouTube, Google/search, TikTok, LinkedIn, Spotify, or another platform. Do not force-fit a Meta template onto a goal that calls for a different channel just because Meta is self-serve.

summary: 2-3 sentences of overall strategy — why these templates together, in plain language.

No invented numbers, results, or guarantees, anywhere in the response:
- Never state a fact — a status, a date, a figure, a campaign's existence — that is not explicitly present in the payload.
- Never promise or imply a specific outcome (reach, bookings, revenue) a campaign will produce.
- You may cite payload.campaigns/analytics numbers as supporting context (e.g. "you already have strong organic traffic" or a specific figure that's actually present), but treat them as context for the reasoning, not as a guarantee for the new recommendation.
- If services_active is false, don't treat booking-related metrics as a problem — there's nothing to book yet, say so plainly if it's relevant.

Language: write summary and every reason entirely in the same language user_goal is written in.`;

const ADVISOR_TOOL = {
  name: "advisor_report",
  description:
    "Return 1-3 recommended campaign templates, drawn only from payload.template_catalog, that best fit the artist's stated goal.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description: "2-3 sentences of overall strategy. No invented numbers, results, or guarantees.",
      },
      recommendations: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        description: "1-3 recommended templates, smallest set that honestly covers the goal.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            template_id: {
              type: "string",
              description: "Must be an id present in payload.template_catalog — never invented.",
            },
            reason: {
              type: "string",
              description: "One sentence. Must state whether this is self-serve or set up personally by Will.",
            },
          },
          required: ["template_id", "reason"],
        },
      },
    },
    required: ["summary", "recommendations"],
  },
} as const;

type AdvisorImpl = (payload: ProfileAdvisorPayload) => Promise<AdvisorResult>;

const anthropicProfileAdvisor: AdvisorImpl = async (payload) => {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: PROFILE_ADVISOR_SYSTEM_PROMPT,
    tools: [ADVISOR_TOOL],
    tool_choice: { type: "tool", name: "advisor_report" },
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("profile-advisor: model returned no tool_use block");

  const validTemplateIds = new Set(payload.template_catalog.map((t) => t.id));
  return normalizeResult(toolUse.input as Record<string, unknown>, payload.user_goal, validTemplateIds);
};

// Defensive normalization — every field is coerced/whitelisted so the UI
// always gets a valid result even though the forced tool schema already
// constrains the shape. user_goal is set directly from the ORIGINAL request
// input (never trusted from the model) so it can never be paraphrased or
// translated on the way out. template_id is additionally checked against
// the real catalog — "only use template ids from the catalog" is enforced
// here, not just asked for in the prompt.
function normalizeResult(
  input: Record<string, unknown>,
  userGoal: string,
  validTemplateIds: Set<string>,
): AdvisorResult {
  const recommendations: TemplateRecommendation[] = Array.isArray(input.recommendations)
    ? input.recommendations
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          template_id: String(x.template_id ?? ""),
          reason: String(x.reason ?? ""),
        }))
        .filter((x) => x.template_id && x.reason && validTemplateIds.has(x.template_id))
        .slice(0, 3)
    : [];

  return {
    user_goal: userGoal,
    summary: String(input.summary ?? ""),
    recommendations,
  };
}

const ADVISOR_PROVIDERS: Record<string, AdvisorImpl> = {
  anthropic: anthropicProfileAdvisor,
};

async function getAdvisorRecommendation(payload: ProfileAdvisorPayload): Promise<AdvisorResult> {
  const provider = Deno.env.get("ADVISOR_PROVIDER") ?? "anthropic";
  const impl = ADVISOR_PROVIDERS[provider];
  if (!impl) throw new Error(`profile-advisor: unknown provider "${provider}"`);
  return impl(payload);
}

// Statuses that mean a boost_campaigns row has been LAUNCHED at least once.
// Confirmed against the live boost_campaigns_status_check CHECK constraint
// (full enum for campaign_type='boost': pending, booked, in_review,
// needs_changes, approved, live, completed, rejected) — 'live' and
// 'completed' are the only two that mean the campaign actually ran;
// everything else (including 'rejected') never launched. 'grow'-type
// campaigns aren't constrained by that CHECK, but 'live'/'completed' are the
// same pipeline-stage names used throughout this codebase for "launched", so
// the same two values are used here regardless of campaign_type.
const ACTIVATED_CAMPAIGN_STATUSES = ["live", "completed"];

// Most recent Monday 00:00:00.000 UTC on or before `now` — the free-tier
// weekly reset boundary. UTC, not the caller's local time zone: every
// timestamp in this project is stored as timestamptz / compared in UTC
// already (see campaign-advisor's own hourly rate limit), and a UTC boundary
// avoids DST entirely. Flagged for Will to confirm.
function startOfCurrentWeekUTC(now: Date): Date {
  const day = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── Identity ─────────────────────────────────────────────────────────────
  // This function is only ever invoked by api.profile-advisor.tsx via a
  // service-role admin client — the SAME pattern the deployed (non-hardened)
  // campaign-advisor uses. That invoke call's Authorization header carries
  // the SERVICE ROLE key, not the real end user's token, so a self-contained
  // Bearer+auth.getUser() check here would reject every real call (this is
  // exactly the reason root CLAUDE.md's Known Open Issues gives for why
  // campaign-advisor's own hardened/ownership-checking variant is deliberately
  // NOT deployed: "would break the service-role web forwarder"). The forwarder
  // is therefore the security boundary for profile_id — it already resolved
  // and owns-checked profile_id against the caller's real session before
  // invoking this function, and passes it through in the body. access_token
  // is that same caller's real session token, passed through separately
  // (NOT the Authorization header, which carries the service-role key for
  // this invoke) specifically so the Lab-only check below can run as them.
  let profileId: string;
  let accessToken: string;
  let userGoal: string;
  try {
    const body = await req.json();
    profileId = String(body?.profile_id ?? "");
    accessToken = String(body?.access_token ?? "");
    userGoal = typeof body?.user_goal === "string" ? body.user_goal.trim() : "";
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!profileId) {
    return json({ error: "profile_id required" }, 400);
  }
  if (!accessToken) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!userGoal) {
    return json({ error: "user_goal required" }, 400);
  }
  if (userGoal.length > 500) {
    return json({ error: "user_goal must be 500 characters or fewer" }, 400);
  }

  // ── Lab-only access (2026-11) ────────────────────────────────────────────
  // Same pattern as sandbox-admin: an anon-key client carrying the caller's
  // OWN JWT, so caller_account_is_lab() resolves auth.uid() to that specific
  // user (a service-role client has no caller identity for the RPC to key
  // off of — that's exactly why access_token is threaded through above).
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: isLab, error: labErr } = await authClient.rpc("caller_account_is_lab");
  if (labErr) {
    console.error("[profile-advisor] is_lab check failed:", labErr.message);
    return json({ error: "Authorization check failed" }, 500);
  }
  if (isLab !== true) {
    return json({ error: "Forbidden" }, 403);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Caller's own profile.
  const { data: callerProfile } = await admin
    .from("profiles")
    .select("id, goal, name, brand_name, first_name, last_name, city, bio")
    .eq("id", profileId)
    .maybeSingle();
  if (!callerProfile?.id) {
    return json({ error: "Profile not found" }, 404);
  }

  // ── Gather campaigns first — needed both for the activation-based rate
  // limit below AND the payload itself, so fetch once. Empty array is a
  // normal result, not an error, for a profile with none yet. Shared with
  // campaign-advisor — see _shared/campaign-insights.ts.
  const campaignInsights = await gatherCampaignInsights(admin, profileId);

  const hasActivatedCampaign = campaignInsights.some((c) =>
    ACTIVATED_CAMPAIGN_STATUSES.includes(String(c.status ?? "")),
  );

  // ── Weekly rate limit — ONLY for profiles with no activated campaign yet.
  // Once a profile has launched at least one campaign (status live or
  // completed), runs are unlimited, regardless of entitlement.
  if (!hasActivatedCampaign) {
    const weekStart = startOfCurrentWeekUTC(new Date());
    const { count: runsThisWeek } = await admin
      .from("profile_advisor_runs")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId)
      .gte("created_at", weekStart.toISOString());
    if ((runsThisWeek ?? 0) >= 1) {
      return json({
        limited: true,
        user_goal: userGoal,
        summary: "You've used this week's free recommendation. It resets Monday — or run a campaign to unlock unlimited recommendations.",
        recommendations: [],
      });
    }
  }

  // ── Gather remaining data ───────────────────────────────────────────────
  const artistName =
    (callerProfile.brand_name as string | null) ||
    (callerProfile.name as string | null) ||
    [callerProfile.first_name, callerProfile.last_name].filter(Boolean).join(" ").trim() ||
    null;

  // 1. Organic vs. campaign traffic — the profile_analytics VIEW, which has a
  //    real organic_views/campaign_views split (utm_source present or not).
  //    Deliberately NOT the Dashboard's get_profile_analytics RPC, whose
  //    views_total/views_prev_period count ALL traffic regardless of source.
  const { data: analyticsRow } = await admin
    .from("profile_analytics")
    .select(
      "organic_views, campaign_views, views_7d, views_prev_7d, unique_visitors_7d, total_views, total_unique_visitors, booking_modal_opens_7d, total_booking_modal_opens, chat_opens_7d, total_chat_opens",
    )
    .eq("profile_id", profileId)
    .maybeSingle();

  const n = (v: unknown): number => Number(v ?? 0) || 0;
  const analytics: ProfileAdvisorPayload["analytics"] = {
    organic_views: n(analyticsRow?.organic_views),
    campaign_views: n(analyticsRow?.campaign_views),
    views_7d: n(analyticsRow?.views_7d),
    views_prev_7d: n(analyticsRow?.views_prev_7d),
    unique_visitors_7d: n(analyticsRow?.unique_visitors_7d),
    total_views: n(analyticsRow?.total_views),
    total_unique_visitors: n(analyticsRow?.total_unique_visitors),
    booking_modal_opens_7d: n(analyticsRow?.booking_modal_opens_7d),
    total_booking_modal_opens: n(analyticsRow?.total_booking_modal_opens),
    chat_opens_7d: n(analyticsRow?.chat_opens_7d),
    total_chat_opens: n(analyticsRow?.total_chat_opens),
  };

  // 2. Active-services gate — same check as campaign-advisor.
  const { count: activeServiceCount } = await admin
    .from("profile_services")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("is_active", true);
  const servicesActive = (activeServiceCount ?? 0) > 0;

  const campaignIds = campaignInsights.map((c) => c.id);

  // 3. Each campaign's own LATEST stored advisor result, if any — reused
  //    as-is, never recomputed. One query, then keep only the first (most
  //    recent, since ordered desc) row per campaign id.
  const latestByCampaign = new Map<string, CampaignAdvisorSnapshot>();
  if (campaignIds.length) {
    const { data: runRows } = await admin
      .from("campaign_advisor_runs")
      .select("boost_campaign_id, result, created_at")
      .in("boost_campaign_id", campaignIds)
      .order("created_at", { ascending: false });
    for (const row of runRows ?? []) {
      const cid = row.boost_campaign_id as string;
      if (latestByCampaign.has(cid)) continue;
      const result = row.result as { health?: string; summary?: string; actions?: { action: string }[] };
      latestByCampaign.set(cid, {
        health: oneOfHealth(result?.health),
        summary: String(result?.summary ?? ""),
        top_action: result?.actions?.[0]?.action ?? null,
      });
    }
  }

  const campaigns: ProfileAdvisorCampaign[] = campaignInsights.map((c) => ({
    ...c,
    latest_advisor_result: latestByCampaign.get(c.id) ?? null,
  }));

  // 4. The live template catalog — every non-hidden row, read with the
  //    service role (the admin client already in use) so every outlet is
  //    visible regardless of the caller's own RLS visibility (e.g. beta-only
  //    rows). What recommendations.template_id must be drawn from.
  const { data: templateRows } = await admin
    .from("campaign_templates")
    .select(
      "id, name, subtitle, description, long_description, display_price, outlets, outlet, delivery, ad_budget_min, ad_budget_max, pro_days",
    )
    .neq("status", "hidden");

  const templateCatalog: TemplateCatalogEntry[] = (templateRows ?? []).map((t) => ({
    id: t.id as string,
    name: t.name as string,
    subtitle: (t.subtitle as string | null) ?? null,
    description: (t.description as string | null) ?? null,
    long_description: (t.long_description as string | null) ?? null,
    display_price: t.display_price == null ? null : Number(t.display_price),
    outlets: t.outlets ?? null,
    outlet: (t.outlet as string | null) ?? null,
    delivery: (t.delivery as string | null) ?? null,
    ad_budget_min: t.ad_budget_min == null ? null : Number(t.ad_budget_min),
    ad_budget_max: t.ad_budget_max == null ? null : Number(t.ad_budget_max),
    pro_days: t.pro_days == null ? null : Number(t.pro_days),
  }));

  const payload: ProfileAdvisorPayload = {
    user_goal: userGoal,
    goal: (callerProfile.goal as string | null) ?? null,
    artist: {
      name: artistName,
      city: (callerProfile.city as string | null) ?? null,
      bio: (callerProfile.bio as string | null) ?? null,
    },
    analytics,
    services_active: servicesActive,
    campaigns,
    template_catalog: templateCatalog,
  };

  // ── LLM call + persist ──────────────────────────────────────────────────
  try {
    const result = await getAdvisorRecommendation(payload);

    const { error: persistErr } = await admin
      .from("profile_advisor_runs")
      .insert({ profile_id: profileId, result });
    if (persistErr) {
      console.error("[profile-advisor] persist error:", persistErr);
    }

    return json(result);
  } catch (err) {
    console.error("[profile-advisor] advisor error:", err);
    return json({ error: "Advisor unavailable" }, 502);
  }
});

function oneOfHealth(v: unknown): AdvisorHealth {
  const allowed: AdvisorHealth[] = ["excellent", "good", "mixed", "needs_attention"];
  return typeof v === "string" && (allowed as string[]).includes(v) ? (v as AdvisorHealth) : "mixed";
}
