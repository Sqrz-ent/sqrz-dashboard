import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// campaign-advisor
//
// Input:  { campaign_id: uuid }
// Output: { health, summary, insights[] (tagged working/watch/action), actions[] }
//
// Gathers a compact, currency-explicit picture of a single boost/grow campaign —
// the manually-entered Meta stats, the SQRZ site-side numbers (reused from the
// exact same source that powers the campaign Analytics "SQRZ · site-side" panel:
// the get_analytics_page RPC), server-computed cost-efficiency metrics, the
// retargetable audience size, and the artist's own previous campaigns (the only
// benchmark source) — then asks one LLM to reason over the whole thing and
// return structured, goal-aware advice. Each result is persisted (append-only)
// to campaign_advisor_runs. No caching: computed live on every call.
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

type PreviousCampaign = {
  goal: string | null;
  status: string | null;
  spend: number | null;
  impressions: number | null;
  cpm: number | null;
  cost_per_landing_page_view: number | null;
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
  // Whether the profile has any active bookable service right now. When false,
  // booking-related metrics must not be judged (there is nothing to book yet).
  services_active: boolean;
  // Benchmark source: the artist's own recent campaigns (empty if none).
  previous_campaigns: PreviousCampaign[];
};

type AdvisorHealth = "excellent" | "good" | "mixed" | "needs_attention";
type Confidence = "high" | "medium" | "low";
type InsightType = "working" | "watch" | "action";

type AdvisorInsight = {
  type: InsightType;
  text: string;
};

type AdvisorActionItem = {
  action: string;
  reason: string;
  confidence: Confidence;
};

type AdvisorResult = {
  health: AdvisorHealth;
  summary: string;
  insights: AdvisorInsight[];
  actions: AdvisorActionItem[];
};

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

Be concise. The whole response is short by design.

health: a categorical label — excellent, good, mixed, or needs_attention. NEVER output a numeric score; a number implies a computed formula that does not exist, which is the same false-precision problem as a fabricated benchmark.

summary: hard cap of 2 sentences.

insights: ONE combined list, maximum 5 items total (not three separate sections). Each item is { type, text } where type is "working" (going well), "watch" (keep an eye on), or "action" (needs doing). Cap each text at ~20 words. Flag anomalies here as "watch" or "action" items — unusually low landing page views, spend pacing off, or tracking mismatches (e.g. a large retargetable audience alongside little on-site engagement can indicate consent-gating or lost tracking). Do not just summarize what is normal.

actions: maximum 2-3 items, each { action, reason, confidence }. action is what the artist should DO (never a bare restated metric). reason cites the specific number(s) that drove it, capped at ~15 words. confidence is high, medium, or low. If nothing genuinely requires action, return an empty array — do NOT manufacture urgency.

Goal-aware metric weighting — lead with the metrics that match payload.goal; do not weight them all equally:
- visibility: reach, impressions, CPM, frequency.
- traffic: landing page views, CTR.
- bookings: booking flow opens, CTA clicks.
- streaming: widget engagement.

Benchmarks: compare ONLY against previous_campaigns — the artist's own past campaigns — and only when that array is non-empty. If it is empty, do not compare; historical comparison is not available yet. NEVER fabricate genre, country, or SQRZ-average comparisons; that data does not exist.

Services / bookings gating: if services_active is false, do NOT treat booking_flow_opens or any booking-related metric as a problem. State plainly that booking performance cannot be judged because there is nothing to book yet.

Email capture: NEVER recommend "add an email capture" — it is a standard element on every profile, not something that can be missing. If low email capture is worth mentioning at all, frame it ONLY as a positioning/visibility issue relative to scroll depth (e.g. the capture sits below where most visitors actually scroll to) — never as something absent.

Hard rules:
- Never state a fact — status, dates, duration, or any figure — that is not explicitly present in the payload. Ground every claim in the provided JSON; treat null or missing values as unknown.
- Every reason/insight that makes a claim must cite the specific number from the payload that drove it.
- Never restate the same specific number in more than one place — pick the single best location for each fact.
- If meta_stats.spend is null (or derived.flags.spend_null is true), say cost-efficiency cannot be judged yet — do NOT invent a cost verdict.
- Currency is in payload.currency — always state amounts with that currency, never a bare number or a different currency.

Do NOT explain what metrics like CPM, CTR, or impressions mean — assume the reader already has that context.`;

const ADVISOR_TOOL = {
  name: "advisor_report",
  description:
    "Return the advisor's verdict-first summary and a prioritized list of concrete actions for this campaign.",
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
        description: "Verdict, hard cap of 2 sentences, grounded in the payload.",
      },
      insights: {
        type: "array",
        description:
          "One combined list, max 5 items total. Tag each as working / watch / action. Flag anomalies here as watch or action.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: ["working", "watch", "action"],
            },
            text: {
              type: "string",
              description: "~20 words max; cite the number if making a claim.",
            },
          },
          required: ["type", "text"],
        },
      },
      actions: {
        type: "array",
        description:
          "Max 2-3 concrete actions. Empty if nothing genuinely requires action — do not manufacture urgency.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              description: "What the artist should DO (never a bare metric).",
            },
            reason: {
              type: "string",
              description:
                "Cites the specific number(s) that drove it; ~15 words max.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
          },
          required: ["action", "reason", "confidence"],
        },
      },
    },
    required: ["health", "summary", "insights", "actions"],
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
    max_tokens: 4096,
    system: ADVISOR_SYSTEM_PROMPT,
    tools: [ADVISOR_TOOL],
    tool_choice: { type: "tool", name: "advisor_report" },
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("advisor: model returned no tool_use block");

  return normalizeResult(toolUse.input as Record<string, unknown>);
};

// Defensive normalization — the forced tool schema constrains the shape, but we
// still coerce/whitelist every field so the UI always receives a valid result.
function normalizeResult(input: Record<string, unknown>): AdvisorResult {
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v)
      ? (v as T)
      : fallback;

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
    health: oneOf<AdvisorHealth>(
      input.health,
      ["excellent", "good", "mixed", "needs_attention"],
      "mixed",
    ),
    summary: String(input.summary ?? ""),
    insights,
    actions,
  };
}

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

  // 1b. Previous campaigns — the artist's OWN recent history. This is the only
  //     benchmark source the advisor is allowed to use (no genre/country/SQRZ
  //     averages). Empty array when there is no prior history.
  const { data: priorRows } = await admin
    .from("boost_campaigns")
    .select(
      "id, goal, status, stat_spend, stat_impressions, stat_cpm, stat_profile_visits",
    )
    .eq("profile_id", profileId)
    .in("status", ["completed", "live"])
    .neq("id", campaignId)
    .order("starts_at", { ascending: false, nullsFirst: false })
    .limit(5);

  const previousCampaigns: PreviousCampaign[] = (priorRows ?? []).map((p) => {
    const pSpend = p.stat_spend == null ? null : Number(p.stat_spend);
    const pVisits =
      p.stat_profile_visits == null ? null : Number(p.stat_profile_visits);
    return {
      goal: (p.goal as string | null) ?? null,
      status: (p.status as string | null) ?? null,
      spend: pSpend,
      impressions:
        p.stat_impressions == null ? null : Number(p.stat_impressions),
      cpm: p.stat_cpm == null ? null : Number(p.stat_cpm),
      cost_per_landing_page_view:
        pSpend != null && pVisits != null && pVisits > 0
          ? round(pSpend / pVisits)
          : null,
    };
  });

  // 1c. Does the profile have any active bookable service right now? Gates
  //     booking-metric judgment: nothing to book → don't fault booking numbers.
  const { count: activeServiceCount } = await admin
    .from("profile_services")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("is_active", true);
  const servicesActive = (activeServiceCount ?? 0) > 0;

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

  // 3. Retargetable audience — distinct fbclid values attributed to this
  //    campaign. Dedup on the fbclid itself, NOT session_id: session_id is
  //    populated on <20% of rows platform-wide (0% on some campaigns), which
  //    silently zeroed this real metric. fbclid lives in event_properties and
  //    is the actual retargetable identifier (Meta re-engages by click id).
  const { data: fbRows } = await admin
    .from("jitsu_events")
    .select("fbclid:event_properties->>fbclid")
    .eq("boost_campaign_id", campaignId)
    .not("event_properties->>fbclid", "is", null)
    .limit(100000);
  const retargetableAudience = new Set(
    (fbRows ?? []).map((r: { fbclid: string | null }) => r.fbclid),
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
  //    meta_stats.landing_page_views (Meta-reported stat_profile_visits) and
  //    sqrz_analytics.views_driven (SQRZ site-side profile_views) are two
  //    independent measurement sources — kept as separate fields, never summed.
  //    cost_per_landing_page_view divides ONLY by the Meta stat_profile_visits.
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
    services_active: servicesActive,
    previous_campaigns: previousCampaigns,
  };

  // 6–8. One LLM call behind the provider boundary; return the parsed result.
  try {
    const result = await getAdvisorRecommendation(payload);

    // Persist (append-only). Fire-and-forget: a storage hiccup must never block
    // the user from seeing the advice they asked for — log and move on.
    const { error: persistErr } = await admin
      .from("campaign_advisor_runs")
      .insert({ boost_campaign_id: campaignId, result });
    if (persistErr) {
      console.error("[campaign-advisor] persist error:", persistErr);
    }

    return json(result);
  } catch (err) {
    console.error("[campaign-advisor] advisor error:", err);
    return json({ error: "Advisor unavailable" }, 502);
  }
});
