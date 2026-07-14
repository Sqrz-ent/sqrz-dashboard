import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// campaign-advisor
//
// Input:  { campaign_id: uuid }
// Output: { summary: string, actions: [{ action, reasoning }] }
//
// Gathers a compact, currency-explicit picture of a single boost/grow campaign —
// the manually-entered Meta stats, the SQRZ site-side numbers (reused from the
// exact same source that powers the campaign Analytics "SQRZ · site-side" panel:
// the get_analytics_page RPC), server-computed cost-efficiency metrics, and the
// retargetable audience size — then asks one LLM to reason over the whole thing
// and return verdict-first advice. No caching: computed live on every call.
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

type Flags = Record<string, boolean>;

type Derived = {
  cost_per_landing_page_view: number | null;
  cost_per_click: number | null;
  cost_per_interaction: number | null;
  interactions_total: number;
  flags: Flags;
};

type AdvisorPayload = {
  currency: string | null;
  goal: string | null;
  artist: {
    name: string | null;
    city: string | null;
    bio: string | null;
    genre: string | null;
    country: string | null;
  };
  campaign: {
    status: string | null;
    starts_at: string | null;
    ends_at: string | null;
    budget_amount: number | null;
  };
  meta_stats: {
    spend: number | null;
    impressions: number | null;
    reach: number | null;
    link_clicks: number | null;
    landing_page_views: number | null;
    cpm: number | null;
  };
  derived: Derived;
  sqrz_analytics: {
    views_driven: number;
    unique_visitors: number;
    booking_flow_opens: number;
    cta_clicks: number;
    widget_opens: number;
  };
  retargetable_audience: number;
};

type AdvisorAction = { action: string; reasoning: string };
type AdvisorResult = { summary: string; actions: AdvisorAction[] };
type AdvisorImpl = (payload: AdvisorPayload) => Promise<AdvisorResult>;

// ─── Derived metrics (Part 4) ─────────────────────────────────────────────────
// Every division is guarded. A null/zero denominator yields `null` for that
// metric plus a flag explaining why — never 0, never Infinity, never omitted.

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function computeDerived(
  spend: number | null,
  landingPageViews: number | null,
  linkClicks: number | null,
  interactionsTotal: number,
): Derived {
  const flags: Flags = {};
  let costPerLandingPageView: number | null = null;
  let costPerClick: number | null = null;
  let costPerInteraction: number | null = null;

  if (spend == null) {
    // Cost efficiency cannot be judged at all until spend is entered.
    flags.spend_null = true;
  }

  // cost_per_landing_page_view = spend / landing_page_views (stat_profile_visits)
  if (spend != null) {
    if (landingPageViews == null) flags.landing_page_views_null = true;
    else if (landingPageViews === 0) flags.landing_page_views_zero = true;
    else costPerLandingPageView = round(spend / landingPageViews);
  }

  // cost_per_click = spend / link_clicks
  if (spend != null) {
    if (linkClicks == null) flags.link_clicks_null = true;
    else if (linkClicks === 0) flags.link_clicks_zero = true;
    else costPerClick = round(spend / linkClicks);
  }

  // cost_per_interaction = spend / (cta_clicks + widget_opens + booking_flow_opens)
  if (spend != null) {
    if (interactionsTotal === 0) flags.interactions_zero = true;
    else costPerInteraction = round(spend / interactionsTotal);
  }

  return {
    cost_per_landing_page_view: costPerLandingPageView,
    cost_per_click: costPerClick,
    cost_per_interaction: costPerInteraction,
    interactions_total: interactionsTotal,
    flags,
  };
}

// ─── LLM boundary (Part 6) ────────────────────────────────────────────────────
// getAdvisorRecommendation is the ONLY place any provider's API is called.
// Nothing else in this file references a specific provider. A second provider
// can be added as another entry in ADVISOR_PROVIDERS and selected by the
// ADVISOR_PROVIDER config value — no scattered conditionals.

const ADVISOR_SYSTEM_PROMPT = `You are an advertising advisor for SQRZ, a booking platform for independent creative professionals (musicians, DJs, artists). You receive one JSON payload describing a single ad campaign and must return advice through the advisor_report tool.

Audience: the artist running the campaign is usually new to advertising. Explain, don't just report.

Hard rules — follow every one:
1. Verdict-first. Every cost metric that is present (not null) must get an explicit good / bad / mixed judgment, not a restated number. Say whether it is good or bad and briefly why.
2. If meta_stats.spend is null (or derived.flags.spend_null is true), state plainly that cost-efficiency cannot be judged yet because no spend has been entered. Do NOT invent a cost verdict in that case.
3. Translate jargon into plain terms for a beginner. For example, explain what a "retargetable audience" actually means (people who clicked the ad and can be shown follow-up ads later) rather than only reporting the count.
4. Be goal-aware. The same numbers must produce meaningfully different advice depending on payload.goal:
   - bookings: judge success by booking_flow_opens, cta_clicks and cost_per_interaction; raw reach matters less.
   - audience: judge success by retargetable_audience growth and unique_visitors; building a pool to re-engage is the point.
   - visibility: judge success by impressions, reach and CPM; awareness matters more than immediate action.
5. Never fabricate SQRZ-specific benchmarks — there is not enough campaign history yet. You may reference general industry ranges, but clearly frame them as general guidance, not SQRZ's own data.
6. Every reasoning field must cite the specific number from the payload that drove it.
7. Never state a fact — status, dates, duration, or any figure — that is not explicitly present in the payload. Ground every claim in the provided JSON. If a value is null or missing, treat it as unknown; do not assume or estimate it.

Currency is given in payload.currency — always state amounts with that currency, never a bare number or a different currency.

Return a concise verdict-first summary and a short prioritized list of concrete, specific actions.`;

const ADVISOR_TOOL = {
  name: "advisor_report",
  description:
    "Return the advisor's verdict-first summary and a prioritized list of concrete actions for this campaign.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description:
          "Verdict-first overview. Give an explicit good/bad/mixed judgment for each available cost metric, translate jargon for a beginner, and stay grounded strictly in the payload. If spend is null, say cost-efficiency cannot be judged yet.",
      },
      actions: {
        type: "array",
        description: "Prioritized, concrete next steps (most important first).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              description: "A specific, actionable recommendation.",
            },
            reasoning: {
              type: "string",
              description:
                "Why this action — must cite the specific number from the payload that drove it.",
            },
          },
          required: ["action", "reasoning"],
        },
      },
    },
    required: ["summary", "actions"],
  },
} as const;

// v1 implementation: Anthropic with forced tool-calling (structured output via a
// tool input_schema, not prompt-only JSON). One model reasons over the full
// combined payload — no per-channel branching.
const anthropicAdvisor: AdvisorImpl = async (payload) => {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    system: ADVISOR_SYSTEM_PROMPT,
    tools: [ADVISOR_TOOL],
    tool_choice: { type: "tool", name: "advisor_report" },
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("advisor: model returned no tool_use block");

  const input = toolUse.input as Partial<AdvisorResult>;
  const actions = Array.isArray(input.actions)
    ? input.actions
        .filter((a): a is AdvisorAction => !!a && typeof a === "object")
        .map((a) => ({
          action: String(a.action ?? ""),
          reasoning: String(a.reasoning ?? ""),
        }))
    : [];

  return { summary: String(input.summary ?? ""), actions };
};

const ADVISOR_PROVIDERS: Record<string, AdvisorImpl> = {
  anthropic: anthropicAdvisor,
};

async function getAdvisorRecommendation(
  payload: AdvisorPayload,
): Promise<AdvisorResult> {
  const provider = Deno.env.get("ADVISOR_PROVIDER") ?? "anthropic";
  const impl = ADVISOR_PROVIDERS[provider];
  if (!impl) throw new Error(`advisor: unknown provider "${provider}"`);
  return impl(payload);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let campaignId: string;
  try {
    const body = await req.json();
    campaignId = String(body?.campaign_id ?? "");
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!campaignId) return json({ error: "campaign_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Campaign row.
  const { data: campaign, error: campaignErr } = await admin
    .from("boost_campaigns")
    .select(
      "id, profile_id, goal, status, budget_amount, budget_currency, stat_spend, stat_impressions, stat_reach, stat_link_clicks, stat_profile_visits, stat_cpm, starts_at, ends_at",
    )
    .eq("id", campaignId)
    .single();

  if (campaignErr || !campaign) {
    return json({ error: "Campaign not found" }, 404);
  }

  const profileId = campaign.profile_id as string;

  // Artist context (best-effort; genre/country are not stored, so stay null).
  const { data: profile } = await admin
    .from("profiles")
    .select("name, brand_name, first_name, last_name, city, bio")
    .eq("id", profileId)
    .single();

  const artistName =
    (profile?.brand_name as string | null) ||
    (profile?.name as string | null) ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
    null;

  // 2. SQRZ site-side numbers — reuse the exact source that powers the campaign
  //    Analytics "SQRZ · site-side" panel (get_analytics_page → boost_campaigns).
  //    The boost_campaign_stats view's live_* columns are hardcoded NULL and are
  //    NOT the real source, so they are deliberately not used here.
  const { data: page } = await admin.rpc("get_analytics_page", {
    p_profile_id: profileId,
    p_days: 3650,
  });
  const campaignsFromPage = (page?.boost_campaigns ?? []) as Array<
    Record<string, unknown>
  >;
  const sqrzRow = campaignsFromPage.find((c) => c.id === campaignId);
  const num = (v: unknown): number => Number(v ?? 0) || 0;

  const sqrz = {
    views_driven: num(sqrzRow?.driven_views),
    unique_visitors: num(sqrzRow?.driven_unique),
    booking_flow_opens: num(sqrzRow?.modal_opens),
    cta_clicks: num(sqrzRow?.cta_clicks),
    widget_opens: num(sqrzRow?.widget_opens),
  };

  // 3. Retargetable audience — distinct visitors (sessions) with a non-null
  //    fbclid attributed to this campaign. fbclid lives in event_properties.
  const { data: fbRows } = await admin
    .from("jitsu_events")
    .select("session_id")
    .eq("boost_campaign_id", campaignId)
    .not("event_properties->>fbclid", "is", null)
    .not("session_id", "is", null)
    .limit(100000);
  const retargetableAudience = new Set(
    (fbRows ?? []).map((r: { session_id: string | null }) => r.session_id),
  ).size;

  // 4. Derived metrics (server-side, guarded).
  const spend =
    campaign.stat_spend == null ? null : Number(campaign.stat_spend);
  const landingPageViews =
    campaign.stat_profile_visits == null
      ? null
      : Number(campaign.stat_profile_visits);
  const linkClicks =
    campaign.stat_link_clicks == null ? null : Number(campaign.stat_link_clicks);
  const interactionsTotal =
    sqrz.cta_clicks + sqrz.widget_opens + sqrz.booking_flow_opens;

  const derived = computeDerived(
    spend,
    landingPageViews,
    linkClicks,
    interactionsTotal,
  );

  // 5. Compact, currency-explicit payload.
  const payload: AdvisorPayload = {
    currency: (campaign.budget_currency as string | null)?.toUpperCase() ?? null,
    goal: (campaign.goal as string | null) ?? null,
    artist: {
      name: artistName,
      city: (profile?.city as string | null) ?? null,
      bio: (profile?.bio as string | null) ?? null,
      genre: null,
      country: null,
    },
    campaign: {
      status: (campaign.status as string | null) ?? null,
      starts_at: (campaign.starts_at as string | null) ?? null,
      ends_at: (campaign.ends_at as string | null) ?? null,
      budget_amount:
        campaign.budget_amount == null ? null : Number(campaign.budget_amount),
    },
    meta_stats: {
      spend,
      impressions:
        campaign.stat_impressions == null
          ? null
          : Number(campaign.stat_impressions),
      reach: campaign.stat_reach == null ? null : Number(campaign.stat_reach),
      link_clicks: linkClicks,
      landing_page_views: landingPageViews,
      cpm: campaign.stat_cpm == null ? null : Number(campaign.stat_cpm),
    },
    derived,
    sqrz_analytics: sqrz,
    retargetable_audience: retargetableAudience,
  };

  // 6–8. One LLM call behind the provider boundary; return the parsed result.
  try {
    const result = await getAdvisorRecommendation(payload);
    return json(result);
  } catch (err) {
    console.error("[campaign-advisor] advisor error:", err);
    return json({ error: "Advisor unavailable" }, 502);
  }
});
