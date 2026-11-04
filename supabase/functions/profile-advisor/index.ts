import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// profile-advisor — pure goal-to-template advisor (2026-11 rework, narrowed
// further same month). Takes the artist's own free-text goal (user_goal) and
// recommends 1-3 campaign templates from the live catalog that fit it. This
// function does NOT analyze the profile — no traffic/analytics, no services
// check, no campaign history, no per-campaign Meta/funnel data, no reuse of
// any campaign's own campaign_advisor_runs verdict. The only context besides
// user_goal is the live template catalog, plus the artist's own name (purely
// to address them, not to inform the recommendation). campaign-advisor and
// _shared/campaign-insights.ts are unrelated to this function and untouched.
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
// Output: { user_goal, summary, recommendations: [{ template_id, reason,
//         availability }] } (1-3 items). availability ("self_serve" | "beta")
//         is set server-side in normalizeResult from the template catalog —
//         never by the model — and the list is sorted self_serve first, then
//         beta, keeping the model's relative order within each group.
//
// Access: Lab-only — public.caller_account_is_lab(), called with the
// caller's own JWT (same pattern as sandbox-admin). Not lab → 403.
//
// No rate limit — every Lab call runs the advisor; there is no per-week or
// per-profile cap of any kind.
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

// A template recommendation — the output shape. availability is never set by
// the model (see ADVISOR_TOOL's schema, which only asks for template_id +
// reason) — normalizeResult sets it from the template catalog.
type TemplateRecommendation = {
  template_id: string;
  reason: string;
  availability: "self_serve" | "beta";
};

type AdvisorResult = {
  user_goal: string;
  summary: string;
  recommendations: TemplateRecommendation[];
};

// One campaign_templates row, as sent to the model — the live catalog the
// recommendation is drawn from. Read with the service role so every outlet
// is visible regardless of the caller's own RLS visibility (e.g. beta-only
// rows). status = 'hidden' rows are excluded entirely.
type TemplateCatalogEntry = {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  long_description: string | null;
  // Self-serve templates only (outlet='meta' AND delivery='self_serve') —
  // omitted entirely (not even null) for beta templates, so the model has no
  // price/budget figure it could ever cite for one. See isSelfServeTemplate.
  display_price?: number | null;
  // Free-text jsonb, shape not enforced at the DB level (e.g. ["Instagram"],
  // ["Facebook","Instagram"]) — passed through as-is, same looseness as the
  // web dashboard's own CampaignTemplate type (lib/templates.ts).
  outlets: unknown;
  // 'meta' | 'other' — combined with delivery below to decide whether a
  // template can be bought directly (outlet='meta' AND delivery='self_serve')
  // or is a beta campaign Will sets up personally.
  outlet: string | null;
  delivery: string | null; // 'self_serve' | 'contact'
  ad_budget_min?: number | null;
  ad_budget_max?: number | null;
  pro_days?: number | null;
};

// outlet='meta' AND delivery='self_serve' — the one condition that decides
// both availability (normalizeResult) and whether price/budget/pro_days are
// included in the catalog sent to the model (below).
function isSelfServeTemplate(entry: { outlet: string | null; delivery: string | null }): boolean {
  return entry.outlet === "meta" && entry.delivery === "self_serve";
}

type ProfileAdvisorPayload = {
  // What the artist typed, in their own words — the ONLY thing that drives
  // which templates get recommended.
  user_goal: string;
  // Purely to address the artist by name in the response — never used to
  // inform which templates are recommended.
  artist: {
    name: string | null;
  };
  // Every non-hidden campaign_templates row — what recommendations.template_id
  // must be drawn from.
  template_catalog: TemplateCatalogEntry[];
};

// ─── LLM boundary ─────────────────────────────────────────────────────────────
// getAdvisorRecommendation is the ONLY place any provider's API is called —
// same provider-swap pattern as campaign-advisor (ADVISOR_PROVIDERS keyed by
// the ADVISOR_PROVIDER env var; only "anthropic" exists today in either file).

const PROFILE_ADVISOR_SYSTEM_PROMPT = `You are a growth advisor for SQRZ, a booking platform for independent creative professionals (musicians, DJs, artists). The artist has described what they want to achieve in their own words — payload.user_goal. You receive one JSON payload with that goal and the full live catalog of campaign templates (payload.template_catalog) — and must recommend 1 to 3 templates through the advisor_report tool that best fit user_goal.

Be concise.

Your only task: match user_goal to the 1-3 best-fitting templates in payload.template_catalog and explain the strategy in 2-3 sentences. You are not analyzing the artist's profile, traffic, or campaign history — you don't have any of that, and nothing here needs it.

recommendations: 1 to 3 items, each { template_id, reason }.
- template_id MUST be an id that actually appears in payload.template_catalog. Never invent, guess, or remember an id from outside the payload.
- reason is ONE sentence explaining why this template fits user_goal — and states the purchase route (see the rule below).
- Pick the smallest set (1-3) that genuinely covers the goal — do not pad to 3 if 1 or 2 is the honest answer.

Purchase route — every reason must make this plain, since it changes what the artist should expect to happen next:
- A template with outlet = "meta" AND delivery = "self_serve" can be started directly in the app right now — a real, one-tap self-serve purchase.
- Every other template (any other outlet, or delivery = "contact") is a beta template: a new channel SQRZ is currently exploring, which is why the artist gets special personal service from the SQRZ team instead of a self-serve purchase — say so plainly in the reason (e.g. "this is a new channel we're exploring, so Will sets it up personally for you") and encourage booking a call. Never imply it's a one-tap or immediately-available in-app purchase. For these templates, never mention a price or a budget figure — the catalog entry for a beta template has no price/budget fields at all, so there is nothing to cite.

Channel fit: prefer a template whose outlet is NOT "meta" (a contact/managed template) whenever user_goal genuinely needs a channel Meta can't serve — e.g. the goal explicitly mentions YouTube, Google/search, TikTok, LinkedIn, Spotify, or another platform. Do not force-fit a Meta template onto a goal that calls for a different channel just because Meta is self-serve.

summary: 2-3 sentences of overall strategy — why these templates together, in plain language.

No invented numbers, results, or guarantees, anywhere in the response:
- Never state a fact — a figure, a status, a result — that is not explicitly present in the payload.
- Never promise or imply a specific outcome (reach, bookings, revenue) a campaign will produce.

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

  return normalizeResult(toolUse.input as Record<string, unknown>, payload.user_goal, payload.template_catalog);
};

// Defensive normalization — every field is coerced/whitelisted so the UI
// always gets a valid result even though the forced tool schema already
// constrains the shape. user_goal is set directly from the ORIGINAL request
// input (never trusted from the model) so it can never be paraphrased or
// translated on the way out. template_id is additionally checked against
// the real catalog — "only use template ids from the catalog" is enforced
// here, not just asked for in the prompt. availability is computed here too,
// from the catalog's own outlet/delivery — never read from the model's
// output — and the final list is sorted self_serve first, then beta, with a
// stable sort so the model's relative order within each group is preserved.
function normalizeResult(
  input: Record<string, unknown>,
  userGoal: string,
  templateCatalog: TemplateCatalogEntry[],
): AdvisorResult {
  const catalogById = new Map(templateCatalog.map((t) => [t.id, t]));

  const recommendations: TemplateRecommendation[] = Array.isArray(input.recommendations)
    ? input.recommendations
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          template_id: String(x.template_id ?? ""),
          reason: String(x.reason ?? ""),
        }))
        .filter((x) => x.template_id && x.reason && catalogById.has(x.template_id))
        .slice(0, 3)
        .map((x) => ({
          ...x,
          availability: (isSelfServeTemplate(catalogById.get(x.template_id)!)
            ? "self_serve"
            : "beta") as "self_serve" | "beta",
        }))
        .sort((a, b) => {
          if (a.availability === b.availability) return 0;
          return a.availability === "self_serve" ? -1 : 1;
        })
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

  // ── Lab-only access ──────────────────────────────────────────────────────
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

  // Caller's own profile — name fields only, purely to address the artist by
  // name in the response. Not city/bio/goal — this function doesn't analyze
  // the profile, so nothing else about it is fetched.
  const { data: callerProfile } = await admin
    .from("profiles")
    .select("id, name, brand_name, first_name, last_name")
    .eq("id", profileId)
    .maybeSingle();
  if (!callerProfile?.id) {
    return json({ error: "Profile not found" }, 404);
  }

  // ── Gather remaining data ───────────────────────────────────────────────
  const artistName =
    (callerProfile.brand_name as string | null) ||
    (callerProfile.name as string | null) ||
    [callerProfile.first_name, callerProfile.last_name].filter(Boolean).join(" ").trim() ||
    null;

  // The live template catalog — every non-hidden row, read with the service
  // role (the admin client already in use) so every outlet is visible
  // regardless of the caller's own RLS visibility (e.g. beta-only rows).
  // What recommendations.template_id must be drawn from.
  const { data: templateRows } = await admin
    .from("campaign_templates")
    .select(
      "id, name, subtitle, description, long_description, display_price, outlets, outlet, delivery, ad_budget_min, ad_budget_max, pro_days",
    )
    .neq("status", "hidden");

  const templateCatalog: TemplateCatalogEntry[] = (templateRows ?? []).map((t) => {
    const outlet = (t.outlet as string | null) ?? null;
    const delivery = (t.delivery as string | null) ?? null;
    const base: TemplateCatalogEntry = {
      id: t.id as string,
      name: t.name as string,
      subtitle: (t.subtitle as string | null) ?? null,
      description: (t.description as string | null) ?? null,
      long_description: (t.long_description as string | null) ?? null,
      outlets: t.outlets ?? null,
      outlet,
      delivery,
    };
    // Beta templates: display_price/ad_budget_min/ad_budget_max/pro_days are
    // omitted entirely (not just nulled) from the catalog sent to the model,
    // so it has no price/budget figure it could ever cite for one.
    if (!isSelfServeTemplate({ outlet, delivery })) {
      return base;
    }
    return {
      ...base,
      display_price: t.display_price == null ? null : Number(t.display_price),
      ad_budget_min: t.ad_budget_min == null ? null : Number(t.ad_budget_min),
      ad_budget_max: t.ad_budget_max == null ? null : Number(t.ad_budget_max),
      pro_days: t.pro_days == null ? null : Number(t.pro_days),
    };
  });

  const payload: ProfileAdvisorPayload = {
    user_goal: userGoal,
    artist: {
      name: artistName,
    },
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
