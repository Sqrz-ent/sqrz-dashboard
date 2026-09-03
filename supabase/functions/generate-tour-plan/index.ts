import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// generate-tour-plan  (v3 — flat venue list, no day scheduling)
//
// Input:  { home_city, target_city, artist_description }
// Output: { cities: string[], venues: [{ ...venue fields, city, match_reason }] }
//         (or { cities: [], venues: [], error } when the two cities aren't
//          plausibly connected by ground travel)
//
// A deliberately loose "here are reasonable venues along a plausible corridor"
// list — NOT an optimized day-by-day itinerary. Two stages:
//
//   1. Corridor + genre mapping (Anthropic, ONE call) — identify a plausible,
//      non-optimal list of corridor cities (home + target + intermediates,
//      capped at MAX_CITIES) and map the artist's genre to venue TYPES +
//      ABOUT-TAGS via explicit few-shot guidance. Includes a plausibility
//      guard: if the two cities aren't sensibly ground-connected (different
//      continents / absurd distance), it returns plausible=false and we stop.
//   2. Venue matching (deterministic, NO LLM) — for each city, pull venues
//      matching type_norm OR any suggested about-tag (broad — not requiring
//      both), combine across cities, and cap the TOTAL at MAX_VENUES by
//      round-robin across cities so no single city dominates. Each venue is
//      tagged with its city and a deterministic match_reason.
//
// There is intentionally NO Stage 3 / LLM pruning: the user wants a list of
// reasonable options, not the AI narrowing to a curated "best pick." Stage 2's
// output IS the response (grounded to real rows, so nothing hallucinated).
//
// Anthropic auth: reuses the project-wide ANTHROPIC_API_KEY (same secret
// campaign-advisor uses; edge secrets are project-wide). Key never leaves the
// server. Endpoint is public (verify_jwt: false), publishable-key callable —
// same pattern as hubspot-beta-slug-request. Cost is bounded by ONE LLM call +
// MAX_CITIES-bounded queries per request.
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
// app's pill list changes, update TYPE_LABEL_TO_NORM here to match.
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
const NORM_TO_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_LABEL_TO_NORM).map(([label, norm]) => [norm, label]),
);

// The 6 about-tags the planner reasons over — verbatim keys inside the
// venues.about JSON (`{ Category: { "Tag": true } }`), verified present in real
// data.
const ABOUT_TAGS = [
  "Live performances",
  "Live music",
  "Dancing",
  "LGBTQ+ friendly",
  "Outdoor seating",
  "Accepts reservations",
] as const;

// Bounds. MAX_CITIES caps Stage-1 output (and thus Stage-2 query count);
// MAX_VENUES caps the flat combined list. PER_CITY_* bound each city's fetch.
const MAX_CITIES = 15;
const MAX_VENUES = 100;
const PER_CITY_TYPE_FETCH = 40; // precise type_norm matches
const PER_CITY_GENERAL_FETCH = 60; // broad batch, JS-matched for about-tags

// Venue projection returned to the client. Explicit (skips the tsvector +
// scraper long tail) but still "full rows". `about`/`type_norm` drive matching.
const VENUE_COLUMNS =
  "id, name, type, type_norm, city, country_code, street, postal_code, state, " +
  "full_address, site, photo, phone, email_1, email_2, email_3, " +
  "facebook, instagram, linkedin, twitter, youtube, whatsapp, " +
  "rating, reviews, latitude, longitude, business_status, about";

// ─── Types ────────────────────────────────────────────────────────────────────

type RequestBody = {
  home_city?: string;
  target_city?: string;
  artist_description?: string;
};

type Corridor = {
  plausible: boolean;
  reason: string;
  cities: string[];
  suggested_types: string[]; // labels (from TYPE_LABELS)
  suggested_about_tags: string[]; // from ABOUT_TAGS
};

type VenueRow = Record<string, unknown> & {
  id: string;
  city?: string | null;
  type?: string | null;
  type_norm?: string | null;
  rating?: unknown;
  about?: string | null;
  business_status?: string | null;
};

type OutVenue = VenueRow & { match_reason: string };

// ─── Stage 1: corridor + genre→type mapping ───────────────────────────────────

const CORRIDOR_SYSTEM_PROMPT =
  `You help independent musicians and DJs find venues along a plausible GROUND-TRAVEL corridor between two cities. You do NOT build an optimized route or a schedule — just a reasonable, loose list of cities someone touring from the home city to the target city might plausibly pass through or near, plus which venue types and attributes suit the artist.

Return everything ONLY through the propose_corridor tool.

PLAUSIBILITY GUARD (check FIRST):
- If home_city and target_city are NOT plausibly connected by ground travel — different continents, separated by an ocean, or an absurd distance for a tour (e.g. Berlin to Sydney, London to Tokyo) — set plausible=false, give a one-sentence reason, and return an EMPTY cities array. Do not invent a corridor in that case.
- Otherwise set plausible=true and proceed.

CITIES (when plausible):
- Include home_city and target_city themselves, plus a loose set of sensible intermediate/corridor cities. Real geography, but it does NOT need to be the fastest or most optimal route — reasonable is enough.
- Prefer cities with some nightlife / live-music / cultural presence over tiny waypoints, but don't overthink it.
- Return AT MOST ${MAX_CITIES} cities total (including the two endpoints). Order them roughly from home toward target. Use the common/widely-used English spelling of each city where one exists (e.g. "Cologne", "Munich", "Prague") since that matches how venue data is stored.

GENRE → VENUE TYPES (be explicit, use these as guidance):
- "reggaeton DJ" / "latin DJ" → Night club, Bar, Lounge, Disco club
- "house/techno DJ" / "underground DJ" → Night club, Disco club, Event venue, Bar
- "rock band" / "indie band" → Live music venue, Concert hall, Bar
- "classical orchestra" / "chamber ensemble" → Concert hall, Performing arts theater, Cultural center
- "jazz musician" / "jazz trio" → Jazz club, Lounge, Bar, Cocktail bar
- "pop/top-40 act" → Event venue, Night club, Bar
- "singer-songwriter" / "acoustic act" → Bar, Cafe-style Lounge, Live music venue, Wine bar
- "cabaret / burlesque performer" → Cabaret club, Lounge, Performing arts theater
Map the ARTIST DESCRIPTION to the closest few types from the allowed list (the tool constrains valid values). Pick the 2-5 most fitting types — err toward slightly broader rather than narrow.

ABOUT-TAGS: pick the attributes (from the allowed list) that fit the artist — e.g. a live band wants "Live performances"/"Live music"; a DJ wants "Dancing"; an LGBTQ+ artist may want "LGBTQ+ friendly". Optional; pick what fits.`;

function corridorTool() {
  return {
    name: "propose_corridor",
    description:
      "Return the plausibility verdict, the corridor cities, and the genre-mapped venue types + about-tags.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        plausible: {
          type: "boolean",
          description:
            "false if home/target aren't sensibly connected by ground travel.",
        },
        reason: {
          type: "string",
          description:
            "When plausible=false, one sentence explaining why. Else may be empty.",
        },
        cities: {
          type: "array",
          description:
            `Corridor cities incl. both endpoints, English spelling, max ${MAX_CITIES}. EMPTY when plausible=false.`,
          items: { type: "string" },
        },
        suggested_types: {
          type: "array",
          description: "Genre-mapped venue types, chosen ONLY from the allowed list.",
          items: { type: "string", enum: TYPE_LABELS },
        },
        suggested_about_tags: {
          type: "array",
          description: "Fitting venue attributes, chosen ONLY from the allowed list.",
          items: { type: "string", enum: [...ABOUT_TAGS] },
        },
      },
      required: ["plausible", "reason", "cities", "suggested_types", "suggested_about_tags"],
    },
  } as const;
}

async function reasonCorridor(
  client: Anthropic,
  body: Required<RequestBody>,
): Promise<Corridor> {
  const userContent = JSON.stringify({
    home_city: body.home_city,
    target_city: body.target_city,
    artist_description: body.artist_description,
  });

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    system: CORRIDOR_SYSTEM_PROMPT,
    tools: [corridorTool()],
    tool_choice: { type: "tool", name: "propose_corridor" },
    messages: [{ role: "user", content: userContent }],
  });

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("corridor: model returned no tool_use block");

  const input = toolUse.input as Record<string, unknown>;
  const typeSet = new Set(TYPE_LABELS);
  const tagSet = new Set<string>(ABOUT_TAGS);

  // Dedupe cities case-insensitively, preserve order, cap at MAX_CITIES.
  const rawCities = Array.isArray(input.cities) ? input.cities : [];
  const seen = new Set<string>();
  const cities: string[] = [];
  for (const c of rawCities) {
    const name = String(c ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cities.push(name);
    if (cities.length >= MAX_CITIES) break;
  }

  return {
    plausible: input.plausible === true,
    reason: String(input.reason ?? ""),
    cities,
    suggested_types: (Array.isArray(input.suggested_types) ? input.suggested_types : [])
      .map((t) => String(t))
      .filter((t) => typeSet.has(t)),
    suggested_about_tags: (Array.isArray(input.suggested_about_tags)
      ? input.suggested_about_tags
      : [])
      .map((t) => String(t))
      .filter((t) => tagSet.has(t)),
  };
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
      if ((group as Record<string, unknown>)[tag] === true) return true;
    }
  }
  return false;
}

function ratingNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isPermanentlyClosed(v: VenueRow): boolean {
  return v.business_status === "CLOSED_PERMANENTLY";
}

/** A city's matched venues, best-first, deduped. Broad match: type OR tag. */
async function matchCity(
  admin: ReturnType<typeof createClient>,
  city: string,
  norms: string[],
  tags: string[],
): Promise<OutVenue[]> {
  const normSet = new Set(norms);

  // Two lean queries: precise type matches, plus a broad top-rated batch that
  // catches tag-only matches. Merged + JS-refined below. Ordering by rating in
  // SQL is a rough prefilter; JS re-sorts. (No SQL business_status/tag filter —
  // both are handled in JS to avoid brittle .or()/ilike encoding on values like
  // "LGBTQ+ friendly".)
  const queries: Promise<{ data: unknown }>[] = [];
  if (norms.length) {
    queries.push(
      admin
        .from("venues")
        .select(VENUE_COLUMNS)
        .eq("reported", false)
        .ilike("city", city)
        .in("type_norm", norms)
        .order("rating", { ascending: false, nullsFirst: false })
        .limit(PER_CITY_TYPE_FETCH)
        .then((r) => ({ data: r.data })),
    );
  }
  queries.push(
    admin
      .from("venues")
      .select(VENUE_COLUMNS)
      .eq("reported", false)
      .ilike("city", city)
      .order("rating", { ascending: false, nullsFirst: false })
      .limit(PER_CITY_GENERAL_FETCH)
      .then((r) => ({ data: r.data })),
  );

  const results = await Promise.all(queries);
  const byId = new Map<string, VenueRow>();
  for (const { data } of results) {
    for (const row of (data ?? []) as VenueRow[]) {
      if (!byId.has(String(row.id))) byId.set(String(row.id), row);
    }
  }

  const matched: Array<{ v: OutVenue; score: number; rating: number }> = [];
  for (const row of byId.values()) {
    if (isPermanentlyClosed(row)) continue;
    const typeMatched = !!row.type_norm && normSet.has(String(row.type_norm));
    const matchedTags = tags.filter((t) => aboutHasTag(row.about, t));
    if (!typeMatched && matchedTags.length === 0) continue;

    // Deterministic, human-readable reason: matched type and/or matched tags.
    const parts: string[] = [];
    if (typeMatched) {
      parts.push(
        NORM_TO_TYPE_LABEL[String(row.type_norm)] ?? String(row.type ?? "Venue"),
      );
    }
    if (matchedTags.length) parts.push(matchedTags.join(", "));
    const match_reason = parts.join(" · ");

    matched.push({
      v: { ...row, city: row.city ?? city, match_reason },
      score: (typeMatched ? 1 : 0) + matchedTags.length,
      rating: ratingNum(row.rating),
    });
  }

  matched.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : b.rating !== a.rating
      ? b.rating - a.rating
      : String(a.v.id).localeCompare(String(b.v.id)),
  );
  return matched.map((m) => m.v);
}

/**
 * Combine per-city lists into one flat list capped at MAX_VENUES, spreading
 * across cities: take one from each city per pass (round-robin), so no single
 * city dominates. Cities with fewer matches simply drop out of later passes and
 * the remaining slots go to cities that still have venues.
 */
function roundRobinCap(perCity: OutVenue[][], cap: number): OutVenue[] {
  const out: OutVenue[] = [];
  const cursors = new Array(perCity.length).fill(0);
  let progressed = true;
  while (out.length < cap && progressed) {
    progressed = false;
    for (let i = 0; i < perCity.length && out.length < cap; i++) {
      const list = perCity[i];
      const c = cursors[i];
      if (c < list.length) {
        out.push(list[c]);
        cursors[i] = c + 1;
        progressed = true;
      }
    }
  }
  return out;
}

// ─── Request validation ───────────────────────────────────────────────────────

function validate(body: RequestBody):
  | { ok: true; value: Required<RequestBody> }
  | { ok: false; message: string } {
  const home_city = (body.home_city ?? "").trim();
  const target_city = (body.target_city ?? "").trim();
  const artist_description = (body.artist_description ?? "").trim();

  if (!home_city) return { ok: false, message: "home_city is required." };
  if (!target_city) return { ok: false, message: "target_city is required." };
  if (!artist_description) {
    return { ok: false, message: "artist_description is required." };
  }
  return { ok: true, value: { home_city, target_city, artist_description } };
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

  // ── Stage 1: corridor + genre mapping ──
  let corridor: Corridor;
  try {
    corridor = await reasonCorridor(anthropic, v.value);
  } catch (err) {
    console.error("[generate-tour-plan] stage 1 (corridor) error:", err);
    return json({ error: "Could not plan a corridor. Please try again." }, 502);
  }

  // Plausibility guard — cities not sensibly ground-connected.
  if (!corridor.plausible) {
    return json({
      cities: [],
      venues: [],
      error: corridor.reason ||
        "Those cities don't look connected by ground travel for a tour.",
    });
  }
  if (!corridor.cities.length) {
    return json({
      cities: [],
      venues: [],
      error: "Couldn't identify a plausible corridor. Please try again.",
    });
  }

  // ── Stage 2: match venues per city, then combine with city-spread cap ──
  const norms = corridor.suggested_types
    .map((label) => TYPE_LABEL_TO_NORM[label])
    .filter((n): n is string => !!n);

  const perCity = await Promise.all(
    corridor.cities.map((city) =>
      matchCity(admin, city, norms, corridor.suggested_about_tags)
    ),
  );

  const venues = roundRobinCap(perCity, MAX_VENUES);

  return json({ cities: corridor.cities, venues });
});
