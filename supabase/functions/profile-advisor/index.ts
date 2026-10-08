import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// profile-advisor
//
// Input:  { profile_id: uuid } — resolved and owns-checked by the forwarder
//         BEFORE invoking this function (see the Identity note in the
//         handler below for why this function cannot verify a Bearer token
//         itself).
// Output: { health, summary, insights[] (tagged working/watch/action), actions[] }
//         — SAME shape as campaign-advisor's AdvisorResult, deliberately, so
//         the Dashboard welcome card can reuse its existing rendering.
//
// Sibling to campaign-advisor, NOT a replacement or extension of it — that
// function and its table (campaign_advisor_runs) are untouched. This one
// reasons over the WHOLE profile: the artist's stated goal (profiles.goal),
// their organic vs. campaign traffic (the profile_analytics view), and every
// campaign they've run — reusing each campaign's own already-stored
// campaign_advisor_runs verdict where one exists, rather than re-deriving
// per-campaign judgment here. Works identically for a profile with zero
// campaigns or near-zero traffic — that is the normal case, not an edge case.
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

type AdvisorHealth = "excellent" | "good" | "mixed" | "needs_attention";
type Confidence = "high" | "medium" | "low";
type InsightType = "working" | "watch" | "action";

type AdvisorInsight = { type: InsightType; text: string };
type AdvisorActionItem = { action: string; reason: string; confidence: Confidence };

// Same result shape as campaign-advisor's AdvisorResult — kept structurally
// identical on purpose (see file header).
type AdvisorResult = {
  health: AdvisorHealth;
  summary: string;
  insights: AdvisorInsight[];
  actions: AdvisorActionItem[];
};

// A campaign's own already-computed verdict, reused as-is when present.
// Deliberately NOT the full AdvisorResult shape — only what's useful as
// context for the profile-level model, to keep the payload small.
type CampaignAdvisorSnapshot = {
  health: AdvisorHealth;
  summary: string;
  top_action: string | null;
};

type ProfileAdvisorCampaign = {
  id: string;
  goal: string | null; // bookings | visibility | audience — the self-serve campaign's OWN goal field, distinct from profiles.goal
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  budget_amount: number | null;
  budget_currency: string | null;
  stat_spend: number | null;
  stat_impressions: number | null;
  stat_link_clicks: number | null;
  stat_profile_visits: number | null;
  // Present only when this campaign has already been analyzed individually
  // (campaign_advisor_runs has a row for it). null, not fabricated, otherwise.
  latest_advisor_result: CampaignAdvisorSnapshot | null;
};

type ProfileAdvisorPayload = {
  // profiles.goal — grow_views | get_booked | other | null (not chosen yet)
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
};

// ─── LLM boundary ─────────────────────────────────────────────────────────────
// getAdvisorRecommendation is the ONLY place any provider's API is called —
// same provider-swap pattern as campaign-advisor (ADVISOR_PROVIDERS keyed by
// the ADVISOR_PROVIDER env var; only "anthropic" exists today in either file).

const PROFILE_ADVISOR_SYSTEM_PROMPT = `You are a growth advisor for SQRZ, a booking platform for independent creative professionals (musicians, DJs, artists). You receive one JSON payload describing an artist's WHOLE PROFILE — their stated goal, their organic and campaign traffic, and every ad campaign they've run (if any) — and must return advice through the advisor_report tool. This is a holistic, profile-level review, not an analysis of one single campaign.

A profile with zero campaigns and very little traffic (single-digit weekly views, no bookings yet) is a completely NORMAL input, not an error or an insufficient-data case — reason about it the same as any other profile, using whatever numbers are present.

Be concise. The whole response is short by design.

health: a categorical label — excellent, good, mixed, or needs_attention. NEVER output a numeric score.

summary: a short verdict + reason ONLY — NO specific figures (the numbers belong in the bullets below, not here). Hard cap ~25 words.

insights: ONE combined list, maximum 5 items total. Each item is { type, text } where type is "working" (going well), "watch" (keep an eye on), or "action" (needs doing). Cap each text at ~12 words. Flag anomalies here as "watch" or "action" — e.g. high organic traffic with very little booking/chat engagement, or a stated goal the current traffic mix doesn't support yet.

actions: maximum 2-3 items, each { action, reason, confidence }. reason cites the specific number(s) that drove it, capped at ~10 words. confidence is high, medium, or low. If nothing genuinely requires action, return an empty array — do NOT manufacture urgency.

Goal-aware weighting — payload.goal is one of grow_views, get_booked, other, or null (not chosen yet — if null, keep advice general and do not assume a goal on the artist's behalf):
- grow_views: weight analytics.organic_views, analytics.campaign_views, and the views_7d vs. views_prev_7d trend.
- get_booked: weight analytics.booking_modal_opens_7d/total and chat_opens_7d/total, and whether any existing campaign's own goal was "bookings".
- other: weight overall traffic and engagement broadly — no single metric should dominate.

WHAT A RECOMMENDED ACTION CAN ACTUALLY BE — read carefully, this is a hard constraint on every action you write:
The artist can self-serve create exactly ONE kind of campaign in the app today: a Meta (Facebook + Instagram) ad campaign with one of three goals — "bookings", "visibility", or "audience". There is no self-serve retargeting, lookalike-audience, or multi-channel campaign creation, and no other ad platform is available self-serve. Anything beyond that — real retargeting or lookalike targeting, another ad channel, or a larger/managed campaign — requires booking a human discovery call inside the app; it is not a one-tap, in-app action.
You MAY use natural, motivating language to describe the STRATEGY behind a suggestion — e.g. calling a visibility-goal campaign aimed at a near-empty profile "a short warm-up campaign", or calling a bookings-goal campaign aimed at an artist with a lot of organic traffic "a more sales-oriented push". Artists respond better to that framing than to raw mechanics. But every action's underlying route must be exactly one of these two, and you must not blur them:
  1. Starting a new self-serve campaign (in-app, Meta only, goal = bookings / visibility / audience) — only ever the right route when what you're recommending IS achievable with one of those three goal pills, however you choose to describe it.
  2. Booking the discovery call — required whenever the real right move needs something self-serve cannot do (genuine retargeting/lookalike targeting, another channel, a bigger or managed campaign).
Never say or imply something is "one tap away", "available now", or that a specific targeting mechanic (e.g. "set up retargeting") exists self-serve when it doesn't. If you are unsure which of the two routes fits, prefer recommending the discovery call — it is always a real, available option for anything self-serve can't do.

Campaigns: for each entry in payload.campaigns, status/goal/dates/stats are always present. latest_advisor_result is present ONLY when that specific campaign has already been analyzed individually (campaign_advisor_runs has a stored row for it) — when present, trust and reuse its health/summary/top_action rather than re-deriving your own judgment of that one campaign from its raw stats. When a campaign has no latest_advisor_result, you may still cite its raw numbers (spend, impressions, clicks) in service of the PROFILE-level picture, but do not invent an individual health verdict for it.

Services / bookings gating: if services_active is false, do NOT treat booking-related metrics as a problem — state plainly that booking performance can't be judged yet because there's nothing to book.

Hard rules:
- Never state a fact — a status, a date, a figure, or a campaign's existence — that is not explicitly present in the payload. Treat null or missing values as unknown, never as zero or as a problem.
- Every reason/insight that makes a claim must cite the specific number from the payload that drove it.
- A specific number may appear in the summary OR in a bullet, never both.
- Do NOT explain what metrics like impressions, CTR, or CPM mean — assume the reader already has that context.`;

const ADVISOR_TOOL = {
  name: "advisor_report",
  description:
    "Return the advisor's verdict-first summary and a prioritized list of concrete actions for this artist's whole profile.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      health: {
        type: "string",
        enum: ["excellent", "good", "mixed", "needs_attention"],
        description: "Categorical health label — NOT a numeric score.",
      },
      summary: {
        type: "string",
        description: "Short verdict + reason, no specific figures, ~25 words max.",
      },
      insights: {
        type: "array",
        description:
          "One combined list, max 5 items total. Tag each as working / watch / action.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["working", "watch", "action"] },
            text: { type: "string", description: "~12 words max; cite the number if making a claim." },
          },
          required: ["type", "text"],
        },
      },
      actions: {
        type: "array",
        description:
          "Max 2-3 concrete actions. Empty if nothing genuinely requires action.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              description:
                "What the artist should DO. Must route to either starting a self-serve campaign (bookings/visibility/audience) or booking the discovery call — never imply a one-tap action that doesn't exist.",
            },
            reason: {
              type: "string",
              description: "Cites the specific number(s) that drove it; ~10 words max.",
            },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["action", "reason", "confidence"],
        },
      },
    },
    required: ["health", "summary", "insights", "actions"],
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

  return normalizeResult(toolUse.input as Record<string, unknown>);
};

// Defensive normalization — mirrors campaign-advisor's normalizeResult exactly
// (same schema, same reasoning: the forced tool schema constrains the shape,
// but every field is still coerced/whitelisted so the UI always gets a valid result).
function normalizeResult(input: Record<string, unknown>): AdvisorResult {
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

  const insights: AdvisorInsight[] = Array.isArray(input.insights)
    ? input.insights
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          type: oneOf<InsightType>(x.type, ["working", "watch", "action"], "watch"),
          text: String(x.text ?? ""),
        }))
        .filter((x) => x.text)
        .slice(0, 5)
    : [];

  const actions: AdvisorActionItem[] = Array.isArray(input.actions)
    ? input.actions
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => ({
          action: String(a.action ?? ""),
          reason: String(a.reason ?? ""),
          confidence: oneOf<Confidence>(a.confidence, ["high", "medium", "low"], "medium"),
        }))
        .filter((a) => a.action)
        .slice(0, 3)
    : [];

  return {
    health: oneOf<AdvisorHealth>(input.health, ["excellent", "good", "mixed", "needs_attention"], "mixed"),
    summary: String(input.summary ?? ""),
    insights,
    actions,
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
  // is therefore the security boundary — it already resolved and owns-checked
  // profile_id against the caller's real session before invoking this
  // function, and passes it through in the body.
  let profileId: string;
  try {
    const body = await req.json();
    profileId = String(body?.profile_id ?? "");
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!profileId) {
    return json({ error: "profile_id required" }, 400);
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
  // normal result, not an error, for a profile with none yet.
  const { data: campaignRows } = await admin
    .from("boost_campaigns")
    .select(
      "id, goal, status, starts_at, ends_at, budget_amount, budget_currency, stat_spend, stat_impressions, stat_link_clicks, stat_profile_visits",
    )
    .eq("profile_id", profileId)
    .order("starts_at", { ascending: false, nullsFirst: false });

  const hasActivatedCampaign = (campaignRows ?? []).some((c) =>
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
        health: null,
        summary: "You've used this week's free recommendation. It resets Monday — or run a campaign to unlock unlimited recommendations.",
        insights: [],
        actions: [],
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

  const campaignIds = (campaignRows ?? []).map((c) => c.id as string);

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

  const campaigns: ProfileAdvisorCampaign[] = (campaignRows ?? []).map((c) => ({
    id: c.id as string,
    goal: (c.goal as string | null) ?? null,
    status: (c.status as string | null) ?? null,
    starts_at: (c.starts_at as string | null) ?? null,
    ends_at: (c.ends_at as string | null) ?? null,
    budget_amount: c.budget_amount == null ? null : Number(c.budget_amount),
    budget_currency: (c.budget_currency as string | null)?.toUpperCase() ?? null,
    stat_spend: c.stat_spend == null ? null : Number(c.stat_spend),
    stat_impressions: c.stat_impressions == null ? null : Number(c.stat_impressions),
    stat_link_clicks: c.stat_link_clicks == null ? null : Number(c.stat_link_clicks),
    stat_profile_visits: c.stat_profile_visits == null ? null : Number(c.stat_profile_visits),
    latest_advisor_result: latestByCampaign.get(c.id as string) ?? null,
  }));

  const payload: ProfileAdvisorPayload = {
    goal: (callerProfile.goal as string | null) ?? null,
    artist: {
      name: artistName,
      city: (callerProfile.city as string | null) ?? null,
      bio: (callerProfile.bio as string | null) ?? null,
    },
    analytics,
    services_active: servicesActive,
    campaigns,
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
