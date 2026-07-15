import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// campaign-advisor
//
// Input:  { campaign_id: uuid }
// Output: { health, summary, working[], watch[], actions[], warnings[], next_steps[] }
//
// Gathers a compact, currency-explicit picture of a single boost/grow campaign —
// the manually-entered Meta stats, the SQRZ site-side numbers (reused from the
// exact same source that powers the campaign Analytics "SQRZ · site-side" panel:
// the get_analytics_page RPC), server-computed cost-efficiency metrics, the
// retargetable audience size, and the artist's own previous campaigns (the only
// benchmark source) — then asks one LLM to reason over the whole thing and
// return structured, goal-aware advice. No caching: computed live on every call.
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
  // Benchmark source: the artist's own recent campaigns (empty if none).
  previous_campaigns: PreviousCampaign[];
};

type AdvisorHealth = "excellent" | "good" | "mixed" | "needs_attention";
type Confidence = "high" | "medium" | "low";

type AdvisorActionItem = {
  action: string;
  reason: string;
  expected_impact: string;
  confidence: Confidence;
};

type AdvisorWarning = {
  type: "tracking" | "pacing" | "anomaly";
  severity: "low" | "medium" | "high";
  detail: string;
};

type AdvisorResult = {
  health: AdvisorHealth;
  summary: string;
  working: string[];
  watch: string[];
  actions: AdvisorActionItem[];
  warnings: AdvisorWarning[];
  next_steps: string[];
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

Open with a 2-3 sentence verdict in the summary field, and a categorical health label in the health field: excellent, good, mixed, or needs_attention. NEVER output a numeric score — a number implies a computed formula that does not exist, which is the same false-precision problem as a fabricated benchmark.

Organize findings into three tiers:
- working: what is going well (short insights).
- watch: things to keep an eye on (short insights).
- actions: things that require action. If nothing rises to the level of requiring action, return an empty actions array — do NOT manufacture urgency.

Every entry in actions must be action-oriented — what the artist should DO — never a bare restated metric with no action attached. Each action has: action, reason (cites specific numbers from the payload), expected_impact, and confidence (high, medium, or low).

Benchmarks: compare ONLY against previous_campaigns — the artist's own past campaigns — and only when that array is non-empty. If previous_campaigns is empty, state plainly that a historical comparison is not available yet. NEVER fabricate genre, country, or SQRZ-average comparisons; that data does not exist.

Goal-aware metric weighting — lead with the metrics that match payload.goal; do not weight them all equally:
- visibility: reach, impressions, CPM, frequency.
- traffic: landing page views, CTR.
- bookings: booking flow opens, CTA clicks.
- streaming: widget engagement.

Actively flag anomalies in the warnings array — unusually low landing page views, CTR dropping, frequency too high, spend pacing off, or tracking mismatches (for example, a large retargetable audience alongside little on-site engagement can indicate consent-gating or lost tracking). Do not just summarize what is normal. Each warning has type (tracking, pacing, or anomaly), severity (low, medium, or high), and detail.

End with next_steps: a prioritized list, maximum 5 items.

Hard rules (unchanged):
- Never state a fact — status, dates, duration, or any figure — that is not explicitly present in the payload. Ground every claim in the provided JSON; treat null or missing values as unknown.
- Every reason must cite the specific number from the payload that drove it.
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
        description: "2-3 sentence verdict, grounded strictly in the payload.",
      },
      working: {
        type: "array",
        items: { type: "string" },
        description: "What is going well — short insights.",
      },
      watch: {
        type: "array",
        items: { type: "string" },
        description: "Things to keep an eye on — short insights.",
      },
      actions: {
        type: "array",
        description:
          "Action-oriented recommendations, most important first. Empty if nothing requires action — do not manufacture urgency.",
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
                "Why — must cite the specific number(s) from the payload that drove it.",
            },
            expected_impact: {
              type: "string",
              description: "What this action is expected to improve.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
          },
          required: ["action", "reason", "expected_impact", "confidence"],
        },
      },
      warnings: {
        type: "array",
        description: "Anomalies or issues actively flagged (empty if none).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["tracking", "pacing", "anomaly"] },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            detail: { type: "string" },
          },
          required: ["type", "severity", "detail"],
        },
      },
      next_steps: {
        type: "array",
        items: { type: "string" },
        description: "Prioritized next steps, maximum 5.",
      },
    },
    required: [
      "health",
      "summary",
      "working",
      "watch",
      "actions",
      "warnings",
      "next_steps",
    ],
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
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v)
      ? (v as T)
      : fallback;

  const actions: AdvisorActionItem[] = Array.isArray(input.actions)
    ? input.actions
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => ({
          action: String(a.action ?? ""),
          reason: String(a.reason ?? ""),
          expected_impact: String(a.expected_impact ?? ""),
          confidence: oneOf<Confidence>(a.confidence, ["high", "medium", "low"], "medium"),
        }))
    : [];

  const warnings: AdvisorWarning[] = Array.isArray(input.warnings)
    ? input.warnings
        .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
        .map((w) => ({
          type: oneOf(w.type, ["tracking", "pacing", "anomaly"] as const, "anomaly"),
          severity: oneOf(w.severity, ["low", "medium", "high"] as const, "low"),
          detail: String(w.detail ?? ""),
        }))
    : [];

  return {
    health: oneOf<AdvisorHealth>(
      input.health,
      ["excellent", "good", "mixed", "needs_attention"],
      "mixed",
    ),
    summary: String(input.summary ?? ""),
    working: strArr(input.working),
    watch: strArr(input.watch),
    actions,
    warnings,
    next_steps: strArr(input.next_steps).slice(0, 5),
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
    previous_campaigns: previousCampaigns,
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
