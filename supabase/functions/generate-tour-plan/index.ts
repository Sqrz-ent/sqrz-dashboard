import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// generate-tour-plan  (v4 — structured pill input, 3-stage: reason → cast wide →
// qualitative read. Flat venue list, no day scheduling.)
//
// Input:  { home_city, target_city, venue_size, goal, vibe_types }
// Output: { cities: string[], venues: [{ ...venue fields, city, match_reason }] }
//         (or { cities: [], venues: [], error } when the two cities aren't
//          plausibly connected by ground travel)
//
// venue_size: "small" (~<250 cap) | "mid" (250-500) | "large" (500-2000+) | "stadium"
// goal:       "get_booked" (venue programs acts / works with promoters) |
//             "rent_venue" (self-produced show, artist rents the space)
// vibe_types: 1+ of "club_nightlife" | "live_music_concert" | "bar_lounge" |
//             "theater_performing_arts" | "outdoor_festival"
//
// This replaces free-text artist_description entirely — a real architectural
// shift, not a tweak. Three stages:
//
//   1. Corridor + type mapping (Anthropic, ONE call) — same plausible,
//      non-optimal corridor-city reasoning as before, but now grounded in
//      venue_size/goal/vibe_types instead of genre-derived guessing. Output
//      suggested_types/suggested_about_tags (from the fixed allowed lists —
//      see TYPE_LABEL_TO_NORM below) is LOOSE GUIDANCE for Stage 2, not a
//      strict filter.
//
//   2. CAST WIDE (deterministic, NO LLM) — per city, fetch a generous
//      rating-ordered batch (PER_CITY_FETCH) and keep any row where
//      (type_norm is in Stage 1's suggested_types) OR (subtypes/description
//      text contains a vibe_type/goal keyword) OR (about JSON text contains a
//      vibe_type/about keyword). The point is to catch venues whose real
//      signal lives in subtypes/about/description rather than the primary
//      type field — a strict type_norm-only query misses those. Matching is
//      done in JS against the fetched batch (not via PostgREST .or()/ilike
//      string-building) — the SAME reason the original deterministic version
//      of this file avoided that path: values like "LGBTQ+ friendly" (and
//      multi-word keywords generally) are brittle to encode into a raw
//      .or()-filter string. Scored + capped per city (PER_CITY_STAGE3_CAP) so
//      Stage 3 gets a generous but bounded pool, not literally everything.
//
//   3. QUALITATIVE READ (Anthropic, ONE call, NEW) — NOT a pruning-to-a-top-
//      pick pass (that was explicitly rejected). Given the full raw candidate
//      data per city (type, subtypes, the full about JSON, rating) plus the
//      user's venue_size/goal/vibe_types, the model (a) drops candidates that
//      clearly don't fit despite passing Stage 2's broad net (e.g. about data
//      reveals a restaurant with no stage/dancing/live-music signal), and (b)
//      writes an honest, specific match_reason for each survivor, grounded in
//      that venue's ACTUAL subtypes/about data — never generic. The survivor
//      set must stay broad; most candidates that reach this stage should
//      survive. venue_size is called out in the prompt as a HARD constraint
//      (not just a preference like goal/vibe), but the LLM isn't 100%
//      reliable on a check this mechanical, so a deterministic backstop
//      (isStadiumScaleMismatch) runs after Stage 3 too — drops any survivor
//      whose type/subtypes mention arena/stadium/amphitheater when
//      venue_size isn't "stadium", the same principle as the
//      business_status=CLOSED_PERMANENTLY exclusion in Stage 2. The existing
//      100-venue global cap + city-spread round-robin is enforced AFTER
//      both, not before.
//
// Keyword design note: `about` is Google-Places-style structured booleans
// (Highlights/Offerings/Atmosphere/Crowd/…) — verified against live data,
// there is no literal "we book touring artists" / "rentable for private
// events" signal anywhere in it. So `goal` rides on type/subtypes/description
// keywords only (which venue types traditionally curate talent vs. are
// typically hired out) — it has no about-keyword branch of its own.
// `description` (Google's short editorial blurb, e.g. "Dance club hosting DJ
// nights & events") was folded in alongside subtypes as a real keyword-match
// target — confirmed with Will: it carries stronger literal signal than
// `about`'s booleans for several vibe_types.
//
// Anthropic auth: reuses the project-wide ANTHROPIC_API_KEY (same secret
// campaign-advisor uses; edge secrets are project-wide). Key never leaves the
// server. Endpoint is public (verify_jwt: false), publishable-key callable —
// same pattern as hubspot-beta-slug-request. Cost is now bounded by TWO LLM
// calls (was one) + MAX_CITIES-bounded queries per request — the added Stage
// 3 call is the accepted cost of qualitative, vibe-grounded match reasons.
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

// ─── Structured input enums ────────────────────────────────────────────────

const VENUE_SIZES = ["small", "mid", "large", "stadium"] as const;
type VenueSize = typeof VENUE_SIZES[number];

const GOALS = ["get_booked", "rent_venue"] as const;
type Goal = typeof GOALS[number];

const VIBE_TYPES = [
  "club_nightlife",
  "live_music_concert",
  "bar_lounge",
  "theater_performing_arts",
  "outdoor_festival",
] as const;
type VibeType = typeof VIBE_TYPES[number];

// ─── Fixed venue-type + about-tag lists (Stage 1's constrained output) ────────
// HARDCODED, and MUST be kept in sync with venuefindr-ios/VenueFindr/VenueFindr/
// Filters.swift (the `VenueTypeFilter` enum) — that Swift enum is the source of
// truth for the app's type pills, and there is no shared DB config table. If the
// app's pill list changes, update TYPE_LABEL_TO_NORM here to match. The REAL
// `type`/`subtypes` universe in the data is much bigger than this list (Arena,
// Stadium, Amphitheater, Festival hall, Opera house, Comedy club, …, verified
// live) — deliberately NOT added here (out of scope, shared with the venue
// browse filter); Stage 2's keyword matching (VIBE_KEYWORDS/GOAL_KEYWORDS
// below) reaches that wider universe directly via free-text search instead.
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

// The 6 about-tags Stage 1 reasons over — verbatim keys inside the venues.about
// JSON (`{ Category: { "Tag": true } }`), verified present in real data. Kept
// as Stage 1's constrained output vocabulary; Stage 2's about-keyword search
// (VIBE_KEYWORDS below) additionally uses several more real tag names beyond
// this list, since that search is free-text substring matching, not a
// JSON-key-enum lookup, so it isn't bound by what Stage 1 is allowed to say.
const ABOUT_TAGS = [
  "Live performances",
  "Live music",
  "Dancing",
  "LGBTQ+ friendly",
  "Outdoor seating",
  "Accepts reservations",
] as const;

// ─── vibe_type / goal → keyword map (Stage 2's deterministic broadening) ──────
// Verified against live `venues` data (type/subtypes/description/about leaf
// keys queried directly) before writing this, not guessed. `aboutTags` are
// literal substrings to search for in the raw `about` text (not required to be
// valid JSON or match the ABOUT_TAGS enum above — plain substring search is
// more robust than JSON-key lookup and survives the ~2% malformed/truncated
// about rows). `textKeywords` are literal substrings searched across
// `subtypes` + `description` together.
const VIBE_KEYWORDS: Record<VibeType, { aboutTags: string[]; textKeywords: string[] }> = {
  club_nightlife: {
    aboutTags: ["Dancing", "Karaoke"],
    textKeywords: [
      "night club", "nightclub", "disco", "dance club", "dance hall",
      "gay night club", "DJ",
    ],
  },
  live_music_concert: {
    aboutTags: ["Live music", "Live performances"],
    textKeywords: [
      "live music", "concert hall", "jazz club", "blues club",
      "rock music club", "musical club", "amphitheater", "arena", "stadium",
      "festival hall", "auditorium", "philharmonic", "opera house",
    ],
  },
  bar_lounge: {
    aboutTags: ["Great cocktails", "Cosy", "Cozy", "Upscale", "Upmarket"],
    textKeywords: [
      "bar", "lounge", "pub", "cocktail bar", "wine bar", "gastropub",
      "sports bar", "piano bar", "beer garden",
    ],
  },
  theater_performing_arts: {
    aboutTags: ["Live performances"],
    textKeywords: [
      "theater", "theatre", "performing arts", "opera house", "cabaret",
      "dinner theater", "drama theater", "comedy club", "auditorium",
      "concert hall", "philharmonic", "cultural center", "art center",
    ],
  },
  outdoor_festival: {
    aboutTags: ["Outdoor seating", "Rooftop seating"],
    textKeywords: [
      "festival hall", "amphitheater", "beer garden", "arena", "stadium",
      "outdoor", "rooftop", "beach club",
    ],
  },
};

// `about` has no usable "programs acts" / "rents out the space" signal
// anywhere in the data (verified) — goal rides on type/subtypes/description
// keywords only, no about-keyword branch.
const GOAL_KEYWORDS: Record<Goal, string[]> = {
  get_booked: [
    "night club", "jazz club", "live music venue", "concert hall",
    "comedy club", "cabaret club", "blues club", "rock music club",
    "musical club", "disco club",
  ],
  rent_venue: [
    "event venue", "banquet hall", "wedding venue", "festival hall",
    "ballroom", "auditorium", "arena", "stadium", "amphitheater",
    "community center", "cultural center",
  ],
};

// Bounds. MAX_CITIES caps Stage-1 output (and thus Stage-2 query count);
// MAX_VENUES caps the final flat combined list (enforced after Stage 3).
// PER_CITY_FETCH is the generous rating-ordered batch Stage 2 scans per city
// (covers every venue outright for all but a handful of mega-cities — verified
// against live per-city counts, e.g. New York tops out at 481). Stage 2 then
// scores + caps its matches at PER_CITY_STAGE3_CAP before handing them to
// Stage 3, so a 15-city corridor sends at most 300 candidates into that call.
const MAX_CITIES = 15;
const MAX_VENUES = 100;
const PER_CITY_FETCH = 300;
const PER_CITY_STAGE3_CAP = 20;

// pg_trgm similarity() cutoff for resolving an LLM city spelling to the real
// `venues.city` value. 0.6 catches the recurring near-spelling/casing/umlaut
// cases (Hannover/Hanover = 0.70, ACCRA/Accra = 1.0) while staying well clear of
// the false-positive band measured against genuinely different cities (≤~0.33,
// e.g. Berlin/Bern 0.33, Hanover/Hamburg 0.14). Exact matches always win. True
// exonyms (München/Munich, Köln/Cologne) score near 0 and are NOT caught — a
// non-issue since venue data is stored in English and Stage 1 emits English.
const CITY_SIMILARITY_THRESHOLD = 0.6;

// Venue projection returned to the client. Explicit (skips the tsvector +
// scraper long tail) but still "full rows". `subtypes`/`description` were
// added in v4 — Stage 2/3 both read them, and the client's Venue Codable
// already has optional fields for both (same projection shape the venue
// browse feature uses), so no client model change was needed to carry them.
const VENUE_COLUMNS =
  "id, name, type, type_norm, subtypes, description, city, country_code, street, postal_code, state, " +
  "full_address, site, photo, phone, email_1, email_2, email_3, " +
  "facebook, instagram, linkedin, twitter, youtube, whatsapp, " +
  "rating, reviews, latitude, longitude, business_status, about";

// ─── Types ────────────────────────────────────────────────────────────────────

type RequestBody = {
  home_city?: string;
  target_city?: string;
  venue_size?: string;
  goal?: string;
  vibe_types?: unknown;
};

type ValidatedRequest = {
  home_city: string;
  target_city: string;
  venue_size: VenueSize;
  goal: Goal;
  vibe_types: VibeType[];
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
  subtypes?: string | null;
  description?: string | null;
  rating?: unknown;
  about?: string | null;
  business_status?: string | null;
};

/** Stage 2 output — a scored, capped candidate, not yet Stage-3-reviewed. */
type CandidateVenue = VenueRow & { city: string };

/** Stage 3 output — a surviving candidate with its grounded match_reason. */
type OutVenue = CandidateVenue & { match_reason: string };

// ─── Request validation ───────────────────────────────────────────────────────

function validate(
  body: RequestBody,
): { ok: true; value: ValidatedRequest } | { ok: false; message: string } {
  const home_city = (body.home_city ?? "").trim();
  const target_city = (body.target_city ?? "").trim();
  if (!home_city) return { ok: false, message: "home_city is required." };
  if (!target_city) return { ok: false, message: "target_city is required." };

  const venue_size = body.venue_size;
  if (typeof venue_size !== "string" || !(VENUE_SIZES as readonly string[]).includes(venue_size)) {
    return { ok: false, message: `venue_size must be one of: ${VENUE_SIZES.join(", ")}.` };
  }

  const goal = body.goal;
  if (typeof goal !== "string" || !(GOALS as readonly string[]).includes(goal)) {
    return { ok: false, message: `goal must be one of: ${GOALS.join(", ")}.` };
  }

  const rawVibes = Array.isArray(body.vibe_types) ? body.vibe_types : [];
  const vibeSet = new Set<VibeType>();
  for (const v of rawVibes) {
    if (typeof v === "string" && (VIBE_TYPES as readonly string[]).includes(v)) {
      vibeSet.add(v as VibeType);
    }
  }
  if (vibeSet.size === 0) {
    return { ok: false, message: `vibe_types must include at least one of: ${VIBE_TYPES.join(", ")}.` };
  }

  return {
    ok: true,
    value: {
      home_city,
      target_city,
      venue_size: venue_size as VenueSize,
      goal: goal as Goal,
      vibe_types: [...vibeSet],
    },
  };
}

// ─── Stage 1: corridor + venue_size/goal/vibe_types → type mapping ────────────

const CORRIDOR_SYSTEM_PROMPT =
  `You help independent musicians and DJs find venues along a plausible GROUND-TRAVEL corridor between two cities. You do NOT build an optimized route or a schedule — just a reasonable, loose list of cities someone touring from the home city to the target city might plausibly pass through or near, plus which venue types and attributes suit what they're looking for.

Return everything ONLY through the propose_corridor tool.

PLAUSIBILITY GUARD (check FIRST):
- If home_city and target_city are NOT plausibly connected by ground travel — different continents, separated by an ocean, or an absurd distance for a tour (e.g. Berlin to Sydney, London to Tokyo) — set plausible=false, give a one-sentence reason, and return an EMPTY cities array. Do not invent a corridor in that case.
- Otherwise set plausible=true and proceed.

CITIES (when plausible):
- Include home_city and target_city themselves, plus a loose set of sensible intermediate/corridor cities. Real geography, but it does NOT need to be the fastest or most optimal route — reasonable is enough.
- Prefer cities with some nightlife / live-music / cultural presence over tiny waypoints, but don't overthink it.
- Return AT MOST ${MAX_CITIES} cities total (including the two endpoints). Order them roughly from home toward target. Use the common/widely-used English spelling of each city where one exists (e.g. "Cologne", "Munich", "Prague") since that matches how venue data is stored.

VENUE_SIZE + GOAL + VIBE_TYPES → VENUE TYPES (be explicit, use these as guidance — this output is LOOSE GUIDANCE for a broader downstream search, not a strict filter, so err toward slightly broader rather than narrow):
- vibe_types (one or more selected — union the types for ALL of them):
  - "club_nightlife" → Night club, Disco club
  - "live_music_concert" → Live music venue, Concert hall, Jazz club
  - "bar_lounge" → Bar, Cocktail bar, Lounge, Wine bar, Pub, Sports bar, Karaoke bar
  - "theater_performing_arts" → Performing arts theater, Cabaret club, Cultural center
  - "outdoor_festival" → Event venue, Community center (the allowed type list has no dedicated outdoor/festival type — a broader downstream search independently catches amphitheaters, festival halls, and beer gardens)
- goal:
  - "get_booked" (the venue programs/curates acts, works with promoters) → lean toward types that traditionally book touring talent: Night club, Live music venue, Jazz club, Cabaret club, Concert hall.
  - "rent_venue" (a self-produced show, the artist rents the space) → lean toward types that are typically hired out: Event venue, Wedding venue, Community center, Cultural center.
- venue_size (capacity tier — a steer, not a literal filter): "small" (~<250) favors Bar, Pub, Cocktail bar, Lounge, Jazz club; "mid" (250-500) favors Night club, Live music venue, Disco club, Cabaret club; "large"/"stadium" (500+) favors Concert hall, Event venue — the two allowed types that can plausibly scale up (a broader downstream search independently catches arenas/stadiums/amphitheaters, which aren't in the allowed type list).
Combine the vibe_types' unioned types with the goal/venue_size steer, then pick the 2-6 best-fitting types overall from the allowed list.

ABOUT-TAGS: pick the attributes (from the allowed list) that fit — e.g. club_nightlife/live_music_concert want "Dancing"/"Live music"/"Live performances"; outdoor_festival wants "Outdoor seating". Optional; pick what fits.`;

function corridorTool() {
  return {
    name: "propose_corridor",
    description:
      "Return the plausibility verdict, the corridor cities, and the venue types + about-tags suited to the request.",
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
          description: "Venue types suited to the request, chosen ONLY from the allowed list.",
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
  body: ValidatedRequest,
): Promise<Corridor> {
  const userContent = JSON.stringify({
    home_city: body.home_city,
    target_city: body.target_city,
    venue_size: body.venue_size,
    goal: body.goal,
    vibe_types: body.vibe_types,
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

// ─── Stage 2: cast a wide net (deterministic, NO LLM) ─────────────────────────

function ratingNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isPermanentlyClosed(v: VenueRow): boolean {
  return v.business_status === "CLOSED_PERMANENTLY";
}

// Deterministic backstop for the most obvious venue_size mismatches —
// layered UNDER Stage 3's qualitative judgment, not replacing it (same
// principle as the business_status=CLOSED_PERMANENTLY exclusion above).
// Confirmed live: Stage 3 occasionally kept a stadium/arena-scale venue for a
// small/mid, non-stadium search despite "arena" being explicitly present in
// that venue's subtypes — the LLM pass is good at nuance but isn't reliable
// enough on a check this mechanical to be the only guard for it.
const STADIUM_SCALE_KEYWORDS = ["arena", "stadium", "amphitheater"];

function isStadiumScaleMismatch(v: VenueRow, requestedSize: VenueSize): boolean {
  if (requestedSize === "stadium") return false;
  const haystack = `${v.type ?? ""} ${v.subtypes ?? ""}`.toLowerCase();
  return STADIUM_SCALE_KEYWORDS.some((k) => haystack.includes(k));
}

/**
 * Fetch a generous rating-ordered batch for one city, then score+filter in JS
 * against three independent signals: type_norm membership, subtypes/description
 * text keywords, about-text keywords. Returns the top PER_CITY_STAGE3_CAP by
 * score (then rating) — a generous but bounded pool for Stage 3 to actually
 * read, not the full fetch.
 */
async function matchCity(
  admin: ReturnType<typeof createClient>,
  city: string,
  norms: string[],
  textKeywords: string[],
  aboutKeywords: string[],
): Promise<CandidateVenue[]> {
  const { data, error } = await admin
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq("reported", false)
    .ilike("city", city)
    .order("rating", { ascending: false, nullsFirst: false })
    .limit(PER_CITY_FETCH);

  if (error) {
    console.error(`[generate-tour-plan] matchCity(${city}) error:`, error);
    return [];
  }

  const normSet = new Set(norms);
  const textNeedles = textKeywords.map((k) => k.toLowerCase());
  const aboutNeedles = aboutKeywords.map((k) => k.toLowerCase());

  const scored: Array<{ v: CandidateVenue; score: number; rating: number }> = [];
  for (const row of (data ?? []) as VenueRow[]) {
    if (isPermanentlyClosed(row)) continue;

    const typeMatched = !!row.type_norm && normSet.has(String(row.type_norm));

    // subtypes + description together, one substring pass over both.
    const textHaystack = `${row.subtypes ?? ""} ${row.description ?? ""}`.toLowerCase();
    const textHits = textNeedles.filter((k) => textHaystack.includes(k)).length;

    // Plain substring search over the raw about text — deliberately NOT a
    // JSON-key lookup, so it still works on the ~2% malformed/truncated rows.
    const aboutHaystack = (row.about ?? "").toLowerCase();
    const aboutHits = aboutNeedles.filter((k) => aboutHaystack.includes(k)).length;

    if (!typeMatched && textHits === 0 && aboutHits === 0) continue;

    scored.push({
      v: { ...row, city: row.city ?? city },
      score: (typeMatched ? 2 : 0) + textHits + aboutHits,
      rating: ratingNum(row.rating),
    });
  }

  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : b.rating !== a.rating
      ? b.rating - a.rating
      : String(a.v.id).localeCompare(String(b.v.id))
  );

  return scored.slice(0, PER_CITY_STAGE3_CAP).map((s) => s.v);
}

/**
 * Resolve corridor city names to the real `venues.city` spelling via the
 * resolve_venue_cities RPC (pg_trgm fuzzy match, exact-case-insensitive wins).
 * Returns a map keyed by lowercased input → resolved spelling. On RPC failure
 * it returns an empty map, so the caller degrades to the original spellings
 * (i.e. pre-fuzzy behavior) rather than erroring.
 */
async function resolveCities(
  admin: ReturnType<typeof createClient>,
  cities: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data, error } = await admin.rpc("resolve_venue_cities", {
    p_cities: cities,
    p_threshold: CITY_SIMILARITY_THRESHOLD,
  });
  if (error) {
    console.error("[generate-tour-plan] resolve_venue_cities error:", error);
    return map;
  }
  for (const row of (data ?? []) as Array<{ input: string; resolved: string }>) {
    map.set(String(row.input).toLowerCase(), String(row.resolved));
  }
  return map;
}

// ─── Stage 3: qualitative read (Anthropic, NEW) ───────────────────────────────

const CURATE_SYSTEM_PROMPT =
  `You are doing a careful qualitative READ of venue candidates that a broad SQL search already pulled for a musician/DJ's tour plan. This is NOT a pass to narrow down to a curated top pick — that was explicitly rejected. Your job, per city:

1. DROP candidates that clearly don't fit despite passing the broad search:
   - venue_size is a HARD CONSTRAINT, not a soft preference — check it against the candidate's actual type/subtypes/about text, the same way you'd check goal or vibe fit. If a "small" or "mid" request's candidate has type/subtypes containing stadium-scale signals (Arena, Stadium, Amphitheater, Festival hall, or about-text implying a large outdoor/mass-capacity venue), DROP it even if it also matches on vibe/type keywords — it's too big for the request. Symmetrically, if a "stadium" or "large" request's candidate is unambiguously small-format (e.g. a plain Cocktail bar/Wine bar/Pub with nothing in its subtypes suggesting a bigger room), DROP it — it's too small. A keyword match on vibe alone never excuses an obvious size mismatch.
   - Also drop anything whose subtypes/about data reveals it's actually something else entirely (e.g. a restaurant with no stage/dancing/live-music signal), or a type flatly mismatched with the requested goal/vibe.
2. For every SURVIVING venue, write an honest, SPECIFIC match_reason that references what's ACTUALLY in that venue's real subtypes/about data — e.g. "about data mentions 'Live music' and 'Dancing' despite being typed as Cocktail bar" or "subtypes list Amphitheater, Festival hall — fits stadium-scale outdoor booking". NEVER write a generic reason like "matches your vibe" — always ground it in a real field value you can see in the candidate.

Keep the survivor set BROAD outside of the checks above. This must NOT become a curated 1-2-per-city list — most candidates that reached you should survive; only drop clear misfits (including clear size mismatches — those are not exceptions to "keep it broad", they're the one thing worth being strict about).

Context for judging fit: venue_size (small/mid/large/stadium — a capacity tier; not a literal column in the data, but check it against real type/subtypes/about wording as described above), goal (get_booked = the venue programs/curates acts vs rent_venue = a self-produced show, the artist rents the space), vibe_types (one or more of club_nightlife/live_music_concert/bar_lounge/theater_performing_arts/outdoor_festival).

Each candidate's "about" field is raw, sometimes-malformed JSON text scraped from Google Places — read it as best-effort text, don't assume it always parses.

Return ONLY through the curate_matches tool. Omit any candidate you're dropping — don't list it with keep=false, just leave it out.`;

function curateTool() {
  return {
    name: "curate_matches",
    description:
      "Return the venues worth keeping — drop clear non-fits, but keep the survivor set broad. Each kept venue gets a specific, grounded match_reason.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kept: {
          type: "array",
          description: "One entry per surviving venue. Omit venues that clearly don't fit.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
                description: "Must exactly match a candidate id from the input.",
              },
              match_reason: {
                type: "string",
                description:
                  "Specific and honest, grounded in this venue's real type/subtypes/about data. Never generic.",
              },
            },
            required: ["id", "match_reason"],
          },
        },
      },
      required: ["kept"],
    },
  } as const;
}

/**
 * Extracts the `kept` array from one curate_matches tool_use's `input`.
 * Observed live: the model sometimes returns `kept` as a JSON-encoded STRING
 * instead of a native array — occasionally even double-wrapped as a
 * stringified `{ kept: [...] }` object rather than the bare array the schema
 * defines. `Array.isArray(input.kept)` alone silently treats all of these as
 * empty. Parse defensively (bounded iterations — never trust model output to
 * terminate on its own) and unwrap either shape.
 */
function extractKept(input: Record<string, unknown>): unknown[] {
  let val: unknown = input.kept;
  for (let i = 0; i < 3 && typeof val === "string"; i++) {
    try {
      val = JSON.parse(val);
    } catch {
      return [];
    }
  }
  if (Array.isArray(val)) return val;
  if (val && typeof val === "object" && Array.isArray((val as Record<string, unknown>).kept)) {
    return (val as Record<string, unknown>).kept as unknown[];
  }
  return [];
}

/**
 * Sends every city's Stage-2 candidate pool to Anthropic in ONE call for a
 * qualitative keep/drop + match_reason pass. Returns a city → surviving
 * OutVenue[] map (cities with no survivors are simply absent). Skips the call
 * entirely (returns an empty map) when Stage 2 found nothing anywhere.
 */
async function curateMatches(
  client: Anthropic,
  request: ValidatedRequest,
  candidatesByCity: Map<string, CandidateVenue[]>,
): Promise<Map<string, OutVenue[]>> {
  const citiesPayload = [...candidatesByCity.entries()]
    .filter(([, candidates]) => candidates.length > 0)
    .map(([city, candidates]) => ({
      city,
      candidates: candidates.map((v) => ({
        id: v.id,
        name: v.name,
        type: v.type ?? null,
        subtypes: v.subtypes ?? null,
        about: v.about ?? null,
        rating: ratingNum(v.rating),
      })),
    }));

  if (citiesPayload.length === 0) return new Map();

  const userContent = JSON.stringify({
    venue_size: request.venue_size,
    goal: request.goal,
    vibe_types: request.vibe_types,
    cities: citiesPayload,
  });

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8000,
    system: CURATE_SYSTEM_PROMPT,
    tools: [curateTool()],
    tool_choice: { type: "tool", name: "curate_matches" },
    messages: [{ role: "user", content: userContent }],
  });

  // The model sometimes splits this into multiple curate_matches tool_use
  // blocks in one response (observed: one per city, likely nudged by this
  // prompt's own "per city" framing) even under forced tool_choice — forced
  // tool_choice constrains WHICH tool, not how many times it's called. Taking
  // only the first block (the original approach here) silently drops every
  // other block's kept venues — merge ALL of them.
  const toolUses = message.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "curate_matches",
  );
  if (!toolUses.length) throw new Error("curate: model returned no tool_use block");

  const kept: unknown[] = [];
  for (const toolUse of toolUses) {
    kept.push(...extractKept(toolUse.input as Record<string, unknown>));
  }

  // id -> match_reason, first occurrence wins on an (unexpected) duplicate id.
  const reasonById = new Map<string, string>();
  for (const entry of kept) {
    if (!entry || typeof entry !== "object") continue;
    const id = String((entry as Record<string, unknown>).id ?? "").trim();
    const reason = String((entry as Record<string, unknown>).match_reason ?? "").trim();
    if (!id || !reason || reasonById.has(id)) continue;
    reasonById.set(id, reason);
  }

  const out = new Map<string, OutVenue[]>();
  for (const [city, candidates] of candidatesByCity) {
    const survivors: OutVenue[] = [];
    for (const v of candidates) {
      const reason = reasonById.get(String(v.id));
      if (reason) survivors.push({ ...v, match_reason: reason });
    }
    if (survivors.length) out.set(city, survivors);
  }
  return out;
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

  // ── Stage 1: corridor + type/tag mapping ──
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

  // ── Stage 2: resolve city spellings, cast a wide net per city ──
  const norms = corridor.suggested_types
    .map((label) => TYPE_LABEL_TO_NORM[label])
    .filter((n): n is string => !!n);

  const textKeywords = [
    ...new Set(
      v.value.vibe_types.flatMap((t) => VIBE_KEYWORDS[t].textKeywords)
        .concat(GOAL_KEYWORDS[v.value.goal]),
    ),
  ];
  const aboutKeywords = [
    ...new Set(
      v.value.vibe_types.flatMap((t) => VIBE_KEYWORDS[t].aboutTags)
        .concat(corridor.suggested_about_tags),
    ),
  ];

  // Fuzzy-resolve each corridor city to the actual spelling stored in `venues`
  // (Hannover → Hanover, ACCRA → Accra, …) so exonym/casing mismatches don't
  // silently return zero venues. Dedupe on the resolved spelling — two distinct
  // LLM inputs can collapse to one real city, and querying it twice would
  // duplicate venues. Unresolved cities keep their original spelling (and
  // simply yield no venues if genuinely absent from the dataset).
  const resolveMap = await resolveCities(admin, corridor.cities);
  const seenCity = new Set<string>();
  const queryCities: string[] = [];
  for (const c of corridor.cities) {
    const resolved = resolveMap.get(c.toLowerCase()) ?? c;
    const key = resolved.toLowerCase();
    if (seenCity.has(key)) continue;
    seenCity.add(key);
    queryCities.push(resolved);
  }

  const perCityCandidates = await Promise.all(
    queryCities.map((city) => matchCity(admin, city, norms, textKeywords, aboutKeywords)),
  );
  const candidatesByCity = new Map<string, CandidateVenue[]>();
  queryCities.forEach((city, i) => candidatesByCity.set(city, perCityCandidates[i]));
  console.log(
    "[generate-tour-plan] stage 2 candidates:",
    JSON.stringify(Object.fromEntries([...candidatesByCity].map(([c, v]) => [c, v.length]))),
  );

  // ── Stage 3: qualitative read — drop clear misfits, write grounded reasons ──
  let curatedByCity: Map<string, OutVenue[]>;
  try {
    curatedByCity = await curateMatches(anthropic, v.value, candidatesByCity);
  } catch (err) {
    console.error("[generate-tour-plan] stage 3 (curate) error:", err);
    return json({ error: "Could not review venue matches. Please try again." }, 502);
  }
  console.log(
    "[generate-tour-plan] stage 3 survivors:",
    JSON.stringify(Object.fromEntries([...curatedByCity].map(([c, v]) => [c, v.length]))),
  );

  // Deterministic size backstop, then global cap + city-spread AFTER Stage 3,
  // not before.
  const perCity = queryCities.map((city) =>
    (curatedByCity.get(city) ?? []).filter(
      (venue) => !isStadiumScaleMismatch(venue, v.value.venue_size),
    )
  );
  const venues = roundRobinCap(perCity, MAX_VENUES);

  return json({ cities: queryCities, venues });
});
