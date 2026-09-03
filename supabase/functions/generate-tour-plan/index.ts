import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// generate-tour-plan
//
// Powers VenueFindr's AI-assisted multi-city tour route planner (pro feature).
//
// Input:  { home_city, target_city, start_date, end_date, artist_description }
// Output: { itinerary: [{ date, city, rationale, candidate_venues[],
//                         recommended_venue_ids[], recommendation_rationale }] }
//
// Three stages:
//   1. Route reasoning (Anthropic)   — reason about a sensible ground-travel
//      route home_city → target_city across the date range, one show/day where
//      sensible, using the model's own geography/city-character knowledge. For
//      each day it also suggests which venue TYPES and ABOUT-TAGS best fit,
//      constrained to the fixed lists below via tool-schema enums.
//   2. Venue matching (deterministic, NO LLM) — for each day, query the real
//      venues table (city + type_norm ∈ suggested + reported=false +
//      not permanently closed), rank by how many suggested about-tags are
//      present-and-true, return the top 5 real rows.
//   3. Grounded ranking (Anthropic)  — given ONLY the real Stage-2 candidates,
//      pick the best 1-2 per day. Server-side we then HARD-FILTER the returned
//      ids against each day's real candidate set, so a hallucinated venue can
//      never reach the response regardless of what the model says.
//
// Anthropic auth: reuses the project-wide ANTHROPIC_API_KEY secret — the SAME
// one the campaign-advisor function already uses (Supabase edge-function secrets
// are shared across all functions in the project). NO new credential is
// provisioned, and the key NEVER leaves the server: clients call this endpoint,
// not Anthropic.
//
// Endpoint auth: public (verify_jwt: false), callable with the project's
// publishable key — same pattern as hubspot-beta-slug-request. NOTE: this fires
// TWO paid LLM calls per request with no per-caller identity, so the date range
// is capped (MAX_TOUR_DAYS) to bound cost/output per call. A stronger abuse
// guard (auth/rate-limit) is a flagged follow-up — see the repo notes.
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

// ─── Fixed venue-type + about-tag lists ───────────────────────────────────────
// HARDCODED, and MUST be kept in sync with venuefindr-ios/VenueFindr/VenueFindr/
// Filters.swift (the `VenueTypeFilter` enum) — that Swift enum is the source of
// truth for the app's type pills, and there is no shared DB config table. If the
// app's pill list changes, update TYPE_LABEL_TO_NORM here to match. (This is the
// same hand-mirrored-constant pattern already used across the Node/Deno boundary
// elsewhere in this project, e.g. apns-push mirroring NotificationList.tsx.)
//
// `label` = what the model reasons about + returns (constrained by tool enums);
// `norm`  = the value matched against the generated `venues.type_norm` column.
const TYPE_LABEL_TO_NORM: Record<string, string> = {
  "Bar": "bar",
  "Event venue": "eventvenue",
  "Night club": "nightclub",
  "Live music venue": "livemusicvenue",
  "Pub": "pub",
  "Cocktail bar": "cocktailbar",
  "Performing arts theater": "performingartstheater",
  "Lounge": "lounge",
  "Concert hall": "concerthall",
  "Community center": "communitycenter",
  "Disco club": "discoclub",
  "Wedding venue": "weddingvenue",
  "Wine bar": "winebar",
  "Sports bar": "sportsbar",
  "Jazz club": "jazzclub",
  "Karaoke bar": "karaokebar",
  "Gay bar": "gaybar",
  "Cabaret club": "cabaretclub",
  "Cultural center": "culturalcenter",
};
const TYPE_LABELS = Object.keys(TYPE_LABEL_TO_NORM);

// The 6 about-tags the planner reasons over. These are verbatim keys inside the
// venues.about JSON (`{ Category: { "Tag": true } }`), verified present in real
// data. Not an app filter (the about-tag filters were removed) — a curated
// subset chosen for touring relevance.
const ABOUT_TAGS = [
  "Live performances",
  "Live music",
  "Dancing",
  "LGBTQ+ friendly",
  "Outdoor seating",
  "Accepts reservations",
] as const;

// Bound the work per request: one day = one venue query + a share of two LLM
// calls' tokens. Keeps a single public, unauthenticated call from exploding.
const MAX_TOUR_DAYS = 45;
const CANDIDATES_PER_DAY = 5;

// Full-ish venue projection returned to the client (Stage 2). Explicit rather
// than "*" to skip the tsvector search_vector column and the long tail of
// scraper fields the planner UI doesn't need, while still being "full rows,
// not just names". `about` + `type_norm` are included: they drive Stage-2
// ranking and Stage-3 grounding.
const VENUE_COLUMNS =
  "id, name, type, type_norm, city, country_code, street, postal_code, state, " +
  "full_address, site, photo, phone, email_1, email_2, email_3, " +
  "facebook, instagram, linkedin, twitter, youtube, whatsapp, " +
  "rating, reviews, latitude, longitude, business_status, about";

// ─── Types ────────────────────────────────────────────────────────────────────

type RequestBody = {
  home_city?: string;
  target_city?: string;
  start_date?: string;
  end_date?: string;
  artist_description?: string;
};

type ItineraryDay = {
  date: string;
  city: string;
  country_hint: string;
  rationale: string;
  suggested_types: string[]; // labels (from TYPE_LABELS)
  suggested_about_tags: string[]; // from ABOUT_TAGS
};

type VenueRow = Record<string, unknown> & { id: string; about?: string | null };

type FinalDay = {
  date: string;
  city: string;
  rationale: string;
  candidate_venues: VenueRow[];
  recommended_venue_ids: string[];
  recommendation_rationale: string;
};

// ─── Stage 1: route reasoning ─────────────────────────────────────────────────

const ROUTE_SYSTEM_PROMPT =
  `You are a tour-routing assistant for independent musicians and DJs. Given a home city, a target destination city, a date range, and a description of the artist, design a sensible GROUND-TRAVEL touring route from the home city to the target city.

Principles:
- The route should progress geographically from home_city toward target_city by road/rail — no back-tracking across the continent, no flights implied. Intermediate stops should be realistically reachable day-to-day.
- Aim for most or all days to include a show. It is fine to include a travel/rest day with no obvious host city, but prefer playable cities.
- Choose intermediate cities using real geography AND city character — university towns, cities with dense international/expat communities, and places with a genuine nightlife/live scene are better hosts than cities that merely sit on the map line. Justify each choice briefly.
- Tailor each day to the artist described. For each day, pick the venue TYPES and ABOUT-TAGS (from the fixed lists provided by the tool schema) that best fit that city + that artist's style. Only choose from those lists.
- country_hint: the country the city is in (helps disambiguate same-named cities).
- Produce one itinerary entry per calendar date in the range (inclusive). Use the exact dates given.

Return the plan ONLY through the propose_route tool.`;

function routeTool() {
  return {
    name: "propose_route",
    description:
      "Return the day-by-day touring itinerary from home_city to target_city.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        itinerary: {
          type: "array",
          description: "One entry per date in the range, in chronological order.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              date: {
                type: "string",
                description: "The calendar date, YYYY-MM-DD, from the given range.",
              },
              city: { type: "string", description: "Host city for this day." },
              country_hint: {
                type: "string",
                description: "Country the city is in.",
              },
              rationale: {
                type: "string",
                description:
                  "Why this city on this day — geography + city character + artist fit. ~30 words.",
              },
              suggested_types: {
                type: "array",
                description:
                  "Best-fit venue types for this day, chosen ONLY from the allowed list.",
                items: { type: "string", enum: TYPE_LABELS },
              },
              suggested_about_tags: {
                type: "array",
                description:
                  "Best-fit venue attributes for this day, chosen ONLY from the allowed list.",
                items: { type: "string", enum: [...ABOUT_TAGS] },
              },
            },
            required: [
              "date",
              "city",
              "country_hint",
              "rationale",
              "suggested_types",
              "suggested_about_tags",
            ],
          },
        },
      },
      required: ["itinerary"],
    },
  } as const;
}

async function reasonRoute(
  client: Anthropic,
  body: Required<RequestBody>,
): Promise<ItineraryDay[]> {
  const userContent = JSON.stringify({
    home_city: body.home_city,
    target_city: body.target_city,
    start_date: body.start_date,
    end_date: body.end_date,
    artist_description: body.artist_description,
  });

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8192,
    system: ROUTE_SYSTEM_PROMPT,
    tools: [routeTool()],
    tool_choice: { type: "tool", name: "propose_route" },
    messages: [{ role: "user", content: userContent }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("route: model returned no tool_use block");

  const input = toolUse.input as { itinerary?: unknown };
  const raw = Array.isArray(input.itinerary) ? input.itinerary : [];

  // Whitelist every field — the enum-constrained schema already limits types/
  // tags, but coerce defensively so a malformed entry can't break Stage 2.
  const typeSet = new Set(TYPE_LABELS);
  const tagSet = new Set<string>(ABOUT_TAGS);
  return raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d) => ({
      date: String(d.date ?? ""),
      city: String(d.city ?? ""),
      country_hint: String(d.country_hint ?? ""),
      rationale: String(d.rationale ?? ""),
      suggested_types: (Array.isArray(d.suggested_types) ? d.suggested_types : [])
        .map((t) => String(t))
        .filter((t) => typeSet.has(t)),
      suggested_about_tags: (Array.isArray(d.suggested_about_tags)
        ? d.suggested_about_tags
        : [])
        .map((t) => String(t))
        .filter((t) => tagSet.has(t)),
    }))
    .filter((d) => d.date && d.city)
    .slice(0, MAX_TOUR_DAYS);
}

// ─── Stage 2: deterministic venue matching ────────────────────────────────────

/** True iff `tag` is present AND set true anywhere in a venue's about JSON. */
function aboutHasTag(about: string | null | undefined, tag: string): boolean {
  if (!about) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(about);
  } catch {
    return false; // ~2% of about rows are malformed/truncated — treat as no tags.
  }
  if (!parsed || typeof parsed !== "object") return false;
  for (const group of Object.values(parsed as Record<string, unknown>)) {
    if (group && typeof group === "object") {
      const v = (group as Record<string, unknown>)[tag];
      if (v === true) return true;
    }
  }
  return false;
}

function aboutTagScore(about: string | null | undefined, tags: string[]): number {
  let score = 0;
  for (const t of tags) if (aboutHasTag(about, t)) score++;
  return score;
}

function ratingNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function matchVenues(
  admin: ReturnType<typeof createClient>,
  day: ItineraryDay,
): Promise<VenueRow[]> {
  const norms = day.suggested_types
    .map((label) => TYPE_LABEL_TO_NORM[label])
    .filter((n): n is string => !!n);

  let q = admin
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq("reported", false)
    // Match the app + RPC: keep null-status rows, exclude only PERMANENTLY closed.
    .or("business_status.is.null,business_status.neq.CLOSED_PERMANENTLY")
    // ilike with no wildcards = case-insensitive EXACT match (matches the app's
    // city filter). Avoids "York" sweeping in "New York"; the tradeoff is that a
    // model city spelled differently from the DB (e.g. Cologne vs Köln) yields
    // no rows — acceptable, and documented.
    .ilike("city", day.city);

  // Only constrain by type when the model actually suggested some (it should).
  if (norms.length) q = q.in("type_norm", norms);

  // Over-fetch, then rank by about-tag richness in-memory and take the top N —
  // Postgres can't rank on the parsed JSON here, so ordering happens server-side.
  const { data, error } = await q.limit(200);
  if (error) {
    console.error(`[generate-tour-plan] venue query failed for ${day.city}:`, error);
    return [];
  }

  const rows = (data ?? []) as VenueRow[];
  rows.sort((a, b) => {
    const sa = aboutTagScore(a.about, day.suggested_about_tags);
    const sb = aboutTagScore(b.about, day.suggested_about_tags);
    if (sb !== sa) return sb - sa; // more matching about-tags first
    const ra = ratingNum(a.rating);
    const rb = ratingNum(b.rating);
    if (rb !== ra) return rb - ra; // then higher rating
    return String(a.id).localeCompare(String(b.id)); // deterministic tiebreak
  });

  return rows.slice(0, CANDIDATES_PER_DAY);
}

// ─── Stage 3: grounded ranking ────────────────────────────────────────────────

const RANK_SYSTEM_PROMPT =
  `You are helping an artist pick which real venues to target on each day of a tour. For each day you are given ONLY a fixed list of real candidate venues (with id, name, type, city, rating, and which relevant attributes each one has). Pick the best 1-2 venues per day for the artist described.

Absolute rules:
- You may ONLY recommend venues by an id that appears in that same day's candidate list. NEVER invent, rename, or reference a venue not in the list. If a day's candidate list is empty, return an empty recommended_venue_ids for that day.
- In recommendation_rationale, refer to concrete details of the venues you picked (name, type, and the attributes shown) and why they fit this artist + city. Keep it to ~30 words per day.

Return everything ONLY through the rank_venues tool.`;

function rankTool() {
  return {
    name: "rank_venues",
    description: "Return the top 1-2 recommended venue ids per day, grounded only in the provided candidates.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              date: { type: "string" },
              recommended_venue_ids: {
                type: "array",
                description: "1-2 ids, each taken verbatim from this day's candidate list.",
                items: { type: "string" },
              },
              recommendation_rationale: {
                type: "string",
                description: "~30 words, referencing the chosen venues' real details.",
              },
            },
            required: ["date", "recommended_venue_ids", "recommendation_rationale"],
          },
        },
      },
      required: ["days"],
    },
  } as const;
}

type RankResult = Map<string, { ids: string[]; rationale: string }>;

async function rankCandidates(
  client: Anthropic,
  artistDescription: string,
  days: Array<{ day: ItineraryDay; candidates: VenueRow[] }>,
): Promise<RankResult> {
  // Compact, grounded view — only what the model needs to choose, and only real
  // rows. The full candidate objects still go back to the client via Stage 2.
  const modelInput = {
    artist_description: artistDescription,
    days: days.map(({ day, candidates }) => ({
      date: day.date,
      city: day.city,
      day_context: day.rationale,
      candidates: candidates.map((v) => ({
        id: v.id,
        name: v.name ?? null,
        type: v.type ?? null,
        city: v.city ?? null,
        rating: v.rating ?? null,
        attributes: ABOUT_TAGS.filter((t) => aboutHasTag(v.about, t)),
      })),
    })),
  };

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: RANK_SYSTEM_PROMPT,
    tools: [rankTool()],
    tool_choice: { type: "tool", name: "rank_venues" },
    messages: [{ role: "user", content: JSON.stringify(modelInput) }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("rank: model returned no tool_use block");

  const input = toolUse.input as { days?: unknown };
  const out: RankResult = new Map();
  const rawDays = Array.isArray(input.days) ? input.days : [];
  for (const d of rawDays) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    const date = String(rec.date ?? "");
    if (!date) continue;
    out.set(date, {
      ids: (Array.isArray(rec.recommended_venue_ids) ? rec.recommended_venue_ids : [])
        .map((x) => String(x)),
      rationale: String(rec.recommendation_rationale ?? ""),
    });
  }
  return out;
}

// ─── Request validation ───────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(body: RequestBody):
  | { ok: true; value: Required<RequestBody>; days: number }
  | { ok: false; message: string } {
  const home_city = (body.home_city ?? "").trim();
  const target_city = (body.target_city ?? "").trim();
  const start_date = (body.start_date ?? "").trim();
  const end_date = (body.end_date ?? "").trim();
  const artist_description = (body.artist_description ?? "").trim();

  if (!home_city) return { ok: false, message: "home_city is required." };
  if (!target_city) return { ok: false, message: "target_city is required." };
  if (!artist_description) {
    return { ok: false, message: "artist_description is required." };
  }
  if (!DATE_RE.test(start_date)) {
    return { ok: false, message: "start_date must be YYYY-MM-DD." };
  }
  if (!DATE_RE.test(end_date)) {
    return { ok: false, message: "end_date must be YYYY-MM-DD." };
  }

  const start = new Date(`${start_date}T00:00:00Z`);
  const end = new Date(`${end_date}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { ok: false, message: "start_date/end_date is not a valid date." };
  }
  if (end < start) {
    return { ok: false, message: "end_date must be on or after start_date." };
  }
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (days > MAX_TOUR_DAYS) {
    return {
      ok: false,
      message: `Tour range too long — max ${MAX_TOUR_DAYS} days.`,
    };
  }

  return {
    ok: true,
    value: { home_city, target_city, start_date, end_date, artist_description },
    days,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const v = validate(body);
  if (!v.ok) return json({ error: v.message }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("[generate-tour-plan] ANTHROPIC_API_KEY is not set");
    return json({ error: "Tour planner unavailable" }, 502);
  }
  const anthropic = new Anthropic({ apiKey });
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Stage 1 ──
  let itinerary: ItineraryDay[];
  try {
    itinerary = await reasonRoute(anthropic, v.value);
  } catch (err) {
    console.error("[generate-tour-plan] stage 1 (route) error:", err);
    return json({ error: "Could not generate a route. Please try again." }, 502);
  }
  if (!itinerary.length) {
    return json({ error: "The planner returned no itinerary. Please try again." }, 502);
  }

  // ── Stage 2 (deterministic) — matched in parallel across days ──
  const matched = await Promise.all(
    itinerary.map(async (day) => ({ day, candidates: await matchVenues(admin, day) })),
  );

  // ── Stage 3 (grounded ranking) — best-effort. If it fails, still return the
  //    itinerary + candidates with empty recommendations rather than 502ing the
  //    whole request (Stage 3 is the "optional but recommended" refinement). ──
  let ranked: RankResult = new Map();
  const daysWithCandidates = matched.filter((m) => m.candidates.length > 0);
  if (daysWithCandidates.length) {
    try {
      ranked = await rankCandidates(
        anthropic,
        v.value.artist_description,
        daysWithCandidates,
      );
    } catch (err) {
      console.error("[generate-tour-plan] stage 3 (rank) error — degrading:", err);
    }
  }

  // ── Merge. Server-side, HARD-FILTER Stage-3 ids against each day's real
  //    candidate set — the definitive guarantee that no hallucinated venue
  //    reaches the response, independent of the prompt. ──
  const finalItinerary: FinalDay[] = matched.map(({ day, candidates }) => {
    const candidateIds = new Set(candidates.map((c) => String(c.id)));
    const r = ranked.get(day.date);
    const validIds = (r?.ids ?? []).filter((id) => candidateIds.has(id)).slice(0, 2);
    return {
      date: day.date,
      city: day.city,
      rationale: day.rationale,
      candidate_venues: candidates,
      recommended_venue_ids: validIds,
      recommendation_rationale: validIds.length ? (r?.rationale ?? "") : "",
    };
  });

  return json({ itinerary: finalItinerary });
});
