import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// generate-tour-plan  (v5 — single venue_character field replaces the old
// venue_size + vibe_types pair entirely. 3-stage: reason → cast wide →
// qualitative read. Flat venue list, no day scheduling.)
//
// Input:  { home_city, target_city, venue_character, goal }
// Output: { cities: string[], venues: [{ ...venue fields, city, match_reason }] }
//         (or { cities: [], venues: [], error } when the two cities aren't
//          plausibly connected by ground travel)
//
// venue_character: single-select, one of —
//   "bar_lounge"      — Bar, Sports bar, Shisha bar, Cafe, Lounge. Ambient/
//                        background music, DJ possible but no live band.
//                        Rarely rented for full productions, occasionally
//                        available for private events.
//   "club_nightlife"  — Club, Nightclub, Beach club, Event venue (run as
//                        nightlife), Disco. DJ/nightlife-driven, sometimes a
//                        live act alongside a DJ. Usually rentable or
//                        co-produced, often has staff who work directly with
//                        promoters.
//   "live_music_hall" — Event venue, Live music hall, Cultural center. Built
//                        for real productions, most likely to support a full
//                        live show or larger act. ALSO covers arena/stadium-
//                        scale venues (2026-09 decision, confirmed with Will —
//                        merged in rather than kept as a separate 4th tier or
//                        excluded entirely, since they're rare enough not to
//                        warrant their own category; see
//                        isStadiumScaleMismatch below).
// goal: "get_booked" (venue programs acts / works with promoters) |
//       "rent_venue" (self-produced show, artist rents the space)
//
// v5 (2026-09) replaced the prior venue_size (small/mid/large/stadium) +
// vibe_types (multi-select: club_nightlife/live_music_concert/bar_lounge/
// theater_performing_arts/outdoor_festival) pair with this single field — a
// full replacement of both prior inputs, not additive. Three stages:
//
//   1. Corridor + type mapping (Anthropic, ONE call) — same plausible,
//      non-optimal corridor-city reasoning as before, but now grounded in
//      venue_character/goal instead of the old venue_size/vibe_types pair.
//      Output suggested_types/suggested_about_tags (from the fixed allowed
//      lists — see TYPE_LABEL_TO_NORM below) is LOOSE GUIDANCE for Stage 2,
//      not a strict filter.
//
//   2. CAST WIDE (deterministic, NO LLM) — per city, fetch a generous
//      rating-ordered batch (PER_CITY_FETCH) and keep any row where
//      (type_norm is in Stage 1's suggested_types) OR (subtypes/description
//      text contains a venue_character/goal keyword) OR (about JSON text
//      contains a venue_character/about keyword). The point is to catch
//      venues whose real signal lives in subtypes/about/description rather
//      than the primary type field — a strict type_norm-only query misses
//      those. Matching is done in JS against the fetched batch (not via
//      PostgREST .or()/ilike string-building) — the SAME reason the original
//      deterministic version of this file avoided that path: values like
//      "LGBTQ+ friendly" (and multi-word keywords generally) are brittle to
//      encode into a raw .or()-filter string. Scored + capped per city
//      (PER_CITY_STAGE3_CAP) so Stage 3 gets a generous but bounded pool, not
//      literally everything.
//
//   3. QUALITATIVE READ (Anthropic, CHUNKED per-city calls) — NOT a pruning-
//      to-a-top-pick pass (that was explicitly rejected). Given the full raw
//      candidate data per city (type, subtypes, the full about JSON, rating)
//      plus the user's venue_character/goal, the model (a) drops candidates
//      that clearly don't fit despite passing Stage 2's broad net (e.g. about
//      data reveals a restaurant with no stage/dancing/live-music signal),
//      and (b) writes an honest, specific match_reason for each survivor,
//      grounded in that venue's ACTUAL subtypes/about data — never generic.
//      The survivor set must stay broad; most candidates that reach this
//      stage should survive. venue_character is called out in the prompt as
//      a HARD constraint (not just a preference like goal), but the LLM
//      isn't 100% reliable on a check this mechanical, so a deterministic
//      backstop (isStadiumScaleMismatch) runs after Stage 3 too — drops any
//      survivor whose type/subtypes mention arena/stadium/amphitheater
//      UNLESS venue_character is "live_music_hall" (which legitimately
//      covers that scale as of the 2026-09 merge above), the same principle
//      as the business_status=CLOSED_PERMANENTLY exclusion in Stage 2. The
//      existing 100-venue global cap + city-spread round-robin is enforced
//      AFTER both, not before.
//
//      CHUNKING (2026-09 fix — see incident note below): one Anthropic call
//      per CITY, never one call spanning the whole corridor. A single large
//      call given every city's candidates at once was observed to silently
//      evaluate ONLY the first city and never touch the rest — a genuine
//      model completeness failure on big multi-group structured input, not a
//      max_tokens truncation (stop_reason came back "tool_use", a normal
//      complete finish, so there was no signal to detect it after the fact).
//      Chunking structurally prevents this: no single call ever has more
//      than one city's worth of candidates to lose track of. A city's
//      uncached pool is further split if it ever exceeds
//      MAX_CANDIDATES_PER_CURATE_CALL (comfortably above PER_CITY_STAGE3_CAP
//      today, kept as a safety net if that cap grows later). Chunks run with
//      bounded concurrency (CURATE_CONCURRENCY), not all-at-once.
//
//      COMPLETENESS SAFEGUARD: after combining every chunk's results, any
//      city that had real Stage-2 candidates but ended up with ZERO verdicts
//      (cached or fresh, kept or dropped) covering any of them is logged
//      loudly as a likely recurrence of this exact failure class — a city
//      simply having nothing worth keeping is normal and silent; a city
//      never being evaluated AT ALL is not.
//
//      CACHING (venue_fit_cache, service-role only): before calling the LLM,
//      every candidate is looked up by (venue_id, venue_character, goal) — a
//      simpler key than the pre-v5 (venue_id, venue_size, goal,
//      vibe_types_key) shape, since venue_character is single-select (no
//      set-union/sort-key needed the way multi-select vibe_types required).
//      A cache hit is resolved directly (fit or not, with its stored
//      match_reason) with no LLM involvement; only the uncached remainder is
//      ever sent to Anthropic, one city-scoped chunk at a time. Fresh
//      verdicts — both kept AND dropped — are UPSERTed back afterward, so the
//      next request sharing that exact combination (same venue, same
//      venue_character/goal) skips the LLM for that venue entirely. Each
//      verdict is written ONLY for candidates that were actually inside the
//      chunk payload the LLM call that produced it received — never for
//      candidates elsewhere in the corridor that call never saw — so a
//      future partial-evaluation bug of this same shape can only ever
//      poison the one city/chunk it touched, not the whole corridor.
//      venue_fit_cache's schema was altered in place for the v5 field swap
//      (venue_size/vibe_types/vibe_types_key columns dropped, venue_character
//      added, unique constraint now (venue_id, venue_character, goal)) — the
//      table held only test/diagnostic rows from earlier development at
//      migration time (confirmed live, not assumed — 154 rows, all from this
//      feature's own build-and-verify cycles), so it was truncated as part
//      of that migration rather than backfilled; no real per-venue verdict
//      data existed yet to preserve. Purely an internal efficiency layer —
//      same request/response contract, same per-city ordering, invisible to
//      the client.
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
// `about`'s booleans for several venue_character values.
//
// Anthropic auth: reuses the project-wide ANTHROPIC_API_KEY (same secret
// campaign-advisor uses; edge secrets are project-wide). Key never leaves the
// server. Endpoint is public (verify_jwt: false), publishable-key callable —
// same pattern as hubspot-beta-slug-request. Cost is now bounded by ONE
// Stage-1 call + up to MAX_CITIES Stage-3 calls (one per city with uncached
// candidates, run with bounded concurrency — see CHUNKING above) +
// MAX_CITIES-bounded queries per request. More total calls than the earlier
// single-call Stage 3, but each is small/cheap and the venue_fit_cache layer
// means most repeat corridors skip most of them entirely — the accepted cost
// of both qualitative, vibe-grounded match reasons AND not silently losing
// cities on large corridors.
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

const GOALS = ["get_booked", "rent_venue"] as const;
type Goal = typeof GOALS[number];

// Replaces the pre-v5 venue_size + vibe_types pair entirely — single-select,
// not additive. See the venue_character doc block at the top of this file for
// the full definition of each value (real-world types + character).
const VENUE_CHARACTERS = ["bar_lounge", "club_nightlife", "live_music_hall"] as const;
type VenueCharacter = typeof VENUE_CHARACTERS[number];

// ─── Fixed venue-type + about-tag lists (Stage 1's constrained output) ────────
// HARDCODED, and MUST be kept in sync with venuefindr-ios/VenueFindr/VenueFindr/
// Filters.swift (the `VenueTypeFilter` enum) — that Swift enum is the source of
// truth for the app's type pills, and there is no shared DB config table. If the
// app's pill list changes, update TYPE_LABEL_TO_NORM here to match. The REAL
// `type`/`subtypes` universe in the data is much bigger than this list (Arena,
// Stadium, Amphitheater, Festival hall, Opera house, Comedy club, …, verified
// live) — deliberately NOT added here (out of scope, shared with the venue
// browse filter); Stage 2's keyword matching (VENUE_CHARACTER_KEYWORDS/
// GOAL_KEYWORDS below) reaches that wider universe directly via free-text
// search instead.
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
// (VENUE_CHARACTER_KEYWORDS below) additionally uses several more real tag
// names beyond this list, since that search is free-text substring matching,
// not a JSON-key-enum lookup, so it isn't bound by what Stage 1 is allowed to
// say.
const ABOUT_TAGS = [
  "Live performances",
  "Live music",
  "Dancing",
  "LGBTQ+ friendly",
  "Outdoor seating",
  "Accepts reservations",
] as const;

// ─── venue_character / goal → keyword map (Stage 2's deterministic broadening) ─
// Verified against live `venues` data (type/subtypes/description/about leaf
// keys queried directly) before writing this, not guessed. `aboutTags` are
// literal substrings to search for in the raw `about` text (not required to be
// valid JSON or match the ABOUT_TAGS enum above — plain substring search is
// more robust than JSON-key lookup and survives the ~2% malformed/truncated
// about rows). `textKeywords` are literal substrings searched across
// `subtypes` + `description` together.
//
// v5 (2026-09) consolidates the pre-v5 5-key VIBE_KEYWORDS map (club_nightlife/
// live_music_concert/bar_lounge/theater_performing_arts/outdoor_festival) into
// these 3 keys: live_music_hall absorbs live_music_concert +
// theater_performing_arts whole, plus outdoor_festival's production-scale
// terms (festival hall/amphitheater/arena/stadium — arena/stadium-scale venues
// merge into this tier per the 2026-09 decision, see the venue_character doc
// block at the top of this file); bar_lounge absorbs outdoor_festival's
// ambient-outdoor terms (beer garden/rooftop/outdoor seating) plus the new
// shisha-bar/cafe types Will named explicitly; club_nightlife is unchanged
// except for the added "beach club" term Will named explicitly.
const VENUE_CHARACTER_KEYWORDS: Record<VenueCharacter, { aboutTags: string[]; textKeywords: string[] }> = {
  bar_lounge: {
    aboutTags: [
      "Great cocktails", "Cosy", "Cozy", "Upscale", "Upmarket",
      "Outdoor seating", "Rooftop seating",
    ],
    textKeywords: [
      "bar", "lounge", "pub", "cocktail bar", "wine bar", "gastropub",
      "sports bar", "piano bar", "beer garden", "shisha bar", "hookah bar",
      "cafe", "café", "karaoke bar", "gay bar", "rooftop",
    ],
  },
  club_nightlife: {
    aboutTags: ["Dancing", "Karaoke"],
    textKeywords: [
      "night club", "nightclub", "disco", "dance club", "dance hall",
      "gay night club", "DJ", "beach club",
    ],
  },
  live_music_hall: {
    aboutTags: ["Live music", "Live performances"],
    textKeywords: [
      "live music", "live music hall", "live music venue", "concert hall",
      "jazz club", "blues club", "rock music club", "musical club",
      "auditorium", "philharmonic", "opera house", "festival hall",
      "amphitheater", "arena", "stadium", "theater", "theatre",
      "performing arts", "cabaret", "dinner theater", "drama theater",
      "comedy club", "cultural center", "art center",
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

// Stage 3 is chunked ONE CITY PER LLM CALL (see the CHUNKING doc note above)
// to structurally prevent the "silently only evaluates the first city"
// failure. MAX_CANDIDATES_PER_CURATE_CALL further splits a single city's
// uncached pool if it ever exceeds this — comfortably above
// PER_CITY_STAGE3_CAP today, kept as a safety net if that cap grows later.
// CURATE_CONCURRENCY bounds how many of these per-city calls run in parallel
// (a 15-city corridor could otherwise fire 15 Anthropic calls at once).
const MAX_CANDIDATES_PER_CURATE_CALL = 45;
const CURATE_CONCURRENCY = 4;

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
  venue_character?: string;
  goal?: string;
};

type ValidatedRequest = {
  home_city: string;
  target_city: string;
  venue_character: VenueCharacter;
  goal: Goal;
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

  const venue_character = body.venue_character;
  if (
    typeof venue_character !== "string" ||
    !(VENUE_CHARACTERS as readonly string[]).includes(venue_character)
  ) {
    return {
      ok: false,
      message: `venue_character must be one of: ${VENUE_CHARACTERS.join(", ")}.`,
    };
  }

  const goal = body.goal;
  if (typeof goal !== "string" || !(GOALS as readonly string[]).includes(goal)) {
    return { ok: false, message: `goal must be one of: ${GOALS.join(", ")}.` };
  }

  return {
    ok: true,
    value: {
      home_city,
      target_city,
      venue_character: venue_character as VenueCharacter,
      goal: goal as Goal,
    },
  };
}

// ─── Stage 1: corridor + venue_character/goal → type mapping ─────────────────

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

VENUE_CHARACTER + GOAL → VENUE TYPES (be explicit, use these as guidance — this output is LOOSE GUIDANCE for a broader downstream search, not a strict filter, so err toward slightly broader rather than narrow):
- venue_character (single selection — replaces the old venue_size + vibe_types pair entirely):
  - "bar_lounge" → ambient/background-music spaces, DJ possible but no live band, rarely rented for full productions (occasionally available for private events): Bar, Cocktail bar, Wine bar, Lounge, Sports bar, Karaoke bar, Gay bar, Pub.
  - "club_nightlife" → DJ/nightlife-driven spaces, sometimes a live act alongside a DJ, usually rentable or co-produced with staff who work directly with promoters: Night club, Disco club.
  - "live_music_hall" → spaces built for real productions, most likely to support a full live show or larger act (this tier also covers arena/stadium-scale venues — there is no separate stadium tier): Event venue, Live music venue, Concert hall, Cultural center, Cabaret club, Performing arts theater, Jazz club, Community center.
- goal:
  - "get_booked" (the venue programs/curates acts, works with promoters) → lean toward types that traditionally book touring talent within the selected venue_character.
  - "rent_venue" (a self-produced show, the artist rents the space) → lean toward types that are typically hired out within the selected venue_character.
Combine the venue_character's typical types with the goal steer, then pick the 2-6 best-fitting types overall from the allowed list.

ABOUT-TAGS: pick the attributes (from the allowed list) that fit — e.g. club_nightlife wants "Dancing"; live_music_hall wants "Live music"/"Live performances"; bar_lounge wants "Outdoor seating" for an ambient/relaxed spot. Optional; pick what fits.`;

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
    venue_character: body.venue_character,
    goal: body.goal,
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

// Deterministic backstop for the most obvious venue_character mismatches —
// layered UNDER Stage 3's qualitative judgment, not replacing it (same
// principle as the business_status=CLOSED_PERMANENTLY exclusion above).
// Confirmed live (pre-v5): Stage 3 occasionally kept a stadium/arena-scale
// venue for a small/mid, non-stadium search despite "arena" being explicitly
// present in that venue's subtypes — the LLM pass is good at nuance but isn't
// reliable enough on a check this mechanical to be the only guard for it.
//
// v5 (2026-09): venue_character has no dedicated "stadium" tier — Will's
// decision was to merge arena/stadium-scale venues into "live_music_hall"
// (the largest of the three tiers) rather than exclude them entirely or add
// a 4th tier, since they're rare enough not to warrant their own category.
// So this backstop now excludes arena/stadium-subtyped venues for
// "bar_lounge"/"club_nightlife" (neither plausibly fits a stadium) but NOT
// for "live_music_hall" (where they legitimately belong).
const STADIUM_SCALE_KEYWORDS = ["arena", "stadium", "amphitheater"];

function isStadiumScaleMismatch(v: VenueRow, character: VenueCharacter): boolean {
  if (character === "live_music_hall") return false;
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
   - venue_character is a HARD CONSTRAINT, not a soft preference — check it against the candidate's actual type/subtypes/about text, the same way you'd check goal fit. The three values, and what actually belongs in each:
     - "bar_lounge" — ambient/background-music spaces (Bar, Sports bar, Shisha bar, Cafe, Lounge). DJ possible but no live band; rarely rented for full productions. DROP a candidate here if its subtypes/about reveal it's actually built for real productions (Concert hall, Live music venue with a real stage, Arena, Stadium, Amphitheater) — too big/production-focused for an ambient bar/lounge request.
     - "club_nightlife" — DJ/nightlife-driven spaces (Club, Nightclub, Beach club, Event venue run as nightlife, Disco), sometimes a live act alongside a DJ. DROP a candidate here if it's actually a quiet bar/cafe with no dancing/DJ/nightlife signal (too small/ambient), OR if it's actually a full production hall/arena/stadium-scale venue (too large/production-focused) — nightclubs are DJ-driven, not full-production venues.
     - "live_music_hall" — spaces built for real productions (Event venue, Live music venue/hall, Concert hall, Cultural center), most likely to support a full live show or larger act. This tier ALSO covers arena/stadium/amphitheater-scale venues — there is no separate stadium tier, so do NOT drop a candidate here just because its subtypes mention Arena/Stadium/Amphitheater; that scale legitimately belongs in this tier. DROP a candidate here only if it's unambiguously a plain small bar/cafe/lounge with nothing in its subtypes suggesting production capability (stage, live music, event hosting) — too small/ambient for a "built for real productions" request.
     A keyword match alone never excuses an obvious character mismatch in either direction.
   - Also drop anything whose subtypes/about data reveals it's actually something else entirely (e.g. a restaurant with no stage/dancing/live-music signal), or a type flatly mismatched with the requested goal.
2. For every SURVIVING venue, write an honest, SPECIFIC match_reason that references what's ACTUALLY in that venue's real subtypes/about data — e.g. "about data mentions 'Live music' and 'Dancing' despite being typed as Cocktail bar" or "subtypes list Amphitheater, Festival hall — fits live_music_hall's production-scale booking". NEVER write a generic reason like "matches your vibe" — always ground it in a real field value you can see in the candidate.

Keep the survivor set BROAD outside of the checks above. This must NOT become a curated 1-2-per-city list — most candidates that reached you should survive; only drop clear misfits (including clear character mismatches — those are not exceptions to "keep it broad", they're the one thing worth being strict about).

Context for judging fit: venue_character (bar_lounge/club_nightlife/live_music_hall — see the tier definitions above; not a literal column in the data, but check it against real type/subtypes/about wording as described), goal (get_booked = the venue programs/curates acts vs rent_venue = a self-produced show, the artist rents the space).

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

// ─── Stage 3 fit cache (venue_fit_cache, service-role only) ───────────────────
// Cross-request cache keyed on (venue_id, venue_character, goal) — once Stage
// 3 has judged a specific venue against a specific parameter combination,
// that verdict (fits or not, plus its match_reason) is reusable by ANY future
// request with the same combination, regardless of which corridor or which
// other venues are in that request's pool. v5 (2026-09) simplified this key
// from the pre-v5 (venue_id, venue_size, goal, vibe_types_key) shape now that
// venue_character is single-select — no set-union/sort-key step needed the
// way multi-select vibe_types required. Pure efficiency layer, invisible to
// the client: cache hits never reach the LLM at all; cache misses go through
// Stage 3 exactly as before and get written back for next time. No
// TTL/invalidation — a stale verdict after upstream venue-data changes is an
// accepted tradeoff, not handled here.

type FitCacheRow = {
  venue_id: string;
  fits: boolean;
  match_reason: string | null;
};

/**
 * One batched lookup across every candidate id in the request, regardless of
 * city — venue_character/goal are constant for the whole request, so this is
 * a single query rather than one per city.
 */
async function lookupFitCache(
  admin: ReturnType<typeof createClient>,
  venueIds: string[],
  request: ValidatedRequest,
): Promise<Map<string, FitCacheRow>> {
  const map = new Map<string, FitCacheRow>();
  if (!venueIds.length) return map;
  const { data, error } = await admin
    .from("venue_fit_cache")
    .select("venue_id, fits, match_reason")
    .in("venue_id", venueIds)
    .eq("venue_character", request.venue_character)
    .eq("goal", request.goal);
  if (error) {
    console.error("[generate-tour-plan] lookupFitCache error:", error);
    return map;
  }
  for (const row of (data ?? []) as FitCacheRow[]) {
    map.set(String(row.venue_id), row);
  }
  return map;
}

/**
 * Write fresh Stage-3 verdicts back to the cache — BOTH kept (fits=true) and
 * dropped (fits=false), so a future request with an obvious misfit also
 * skips the LLM for it, not just future keepers. UPSERTs on the table's
 * (venue_id, venue_character, goal) unique constraint.
 */
async function writeFitCache(
  admin: ReturnType<typeof createClient>,
  request: ValidatedRequest,
  verdicts: FitCacheRow[],
): Promise<void> {
  if (!verdicts.length) return;
  const rows = verdicts.map((v) => ({
    venue_id: v.venue_id,
    venue_character: request.venue_character,
    goal: request.goal,
    fits: v.fits,
    match_reason: v.match_reason,
    computed_at: new Date().toISOString(),
  }));
  const { error } = await admin
    .from("venue_fit_cache")
    .upsert(rows, { onConflict: "venue_id,venue_character,goal" });
  if (error) {
    console.error("[generate-tour-plan] writeFitCache error:", error);
  }
}

type CurateChunk = { city: string; candidates: CandidateVenue[] };

/**
 * Splits every city's UNCACHED candidate pool into one-city-only chunks (no
 * chunk ever spans more than one city), further sliced at
 * MAX_CANDIDATES_PER_CURATE_CALL if a single city's pool ever exceeds it.
 * This is the structural fix for the "one big call silently only evaluates
 * the first city" bug — a chunk simply has no other city's candidates in it
 * to lose track of. Cities fully covered by cache produce zero chunks.
 */
function buildCurateChunks(
  candidatesByCity: Map<string, CandidateVenue[]>,
  cacheByVenueId: Map<string, FitCacheRow>,
): CurateChunk[] {
  const chunks: CurateChunk[] = [];
  for (const [city, candidates] of candidatesByCity) {
    const uncached = candidates.filter((v) => !cacheByVenueId.has(String(v.id)));
    for (let i = 0; i < uncached.length; i += MAX_CANDIDATES_PER_CURATE_CALL) {
      chunks.push({ city, candidates: uncached.slice(i, i + MAX_CANDIDATES_PER_CURATE_CALL) });
    }
  }
  return chunks;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once — a plain
 * worker-pool, no external dependency. Used so a 15-city corridor doesn't
 * fire 15 concurrent Anthropic calls at once.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * One Anthropic call scoped to a SINGLE city's candidate chunk — never the
 * whole corridor. Returns a map of id -> match_reason for venues this chunk
 * kept (venues it didn't mention are implicitly dropped, exactly as before).
 */
async function curateChunk(
  client: Anthropic,
  request: ValidatedRequest,
  chunk: CurateChunk,
): Promise<Map<string, string>> {
  const userContent = JSON.stringify({
    venue_character: request.venue_character,
    goal: request.goal,
    cities: [{
      city: chunk.city,
      candidates: chunk.candidates.map((v) => ({
        id: v.id,
        name: v.name,
        type: v.type ?? null,
        subtypes: v.subtypes ?? null,
        about: v.about ?? null,
        rating: ratingNum(v.rating),
      })),
    }],
  });

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8000,
    system: CURATE_SYSTEM_PROMPT,
    tools: [curateTool()],
    tool_choice: { type: "tool", name: "curate_matches" },
    messages: [{ role: "user", content: userContent }],
  });

  // The model sometimes splits its response into multiple curate_matches
  // tool_use blocks even under forced tool_choice (forced tool_choice
  // constrains WHICH tool, not how many times it's called) — merge ALL of
  // them rather than taking just the first.
  const toolUses = message.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "curate_matches",
  );
  if (!toolUses.length) {
    throw new Error(`curate: model returned no tool_use block for city "${chunk.city}"`);
  }

  const kept: unknown[] = [];
  for (const toolUse of toolUses) {
    kept.push(...extractKept(toolUse.input as Record<string, unknown>));
  }

  const keptById = new Map<string, string>();
  for (const entry of kept) {
    if (!entry || typeof entry !== "object") continue;
    const id = String((entry as Record<string, unknown>).id ?? "").trim();
    const reason = String((entry as Record<string, unknown>).match_reason ?? "").trim();
    if (!id || !reason || keptById.has(id)) continue;
    keptById.set(id, reason);
  }
  return keptById;
}

/**
 * Sends only the UNCACHED slice of each city's Stage-2 candidate pool to
 * Anthropic for a qualitative keep/drop + match_reason pass — candidates
 * already judged for this exact (venue_character, goal) combination are
 * resolved straight from venue_fit_cache, no LLM call needed for them.
 * Uncached candidates are chunked strictly per-city (see buildCurateChunks)
 * and run with bounded concurrency — never one call spanning the whole
 * corridor. Fresh verdicts (both keeps and drops) are written back scoped to
 * exactly the chunk that produced them before returning. Returns a city →
 * surviving OutVenue[] map (cities with no survivors are simply absent) —
 * same shape and same per-city ordering as before caching/chunking existed.
 */
async function curateMatches(
  client: Anthropic,
  admin: ReturnType<typeof createClient>,
  request: ValidatedRequest,
  candidatesByCity: Map<string, CandidateVenue[]>,
): Promise<Map<string, OutVenue[]>> {
  const allCandidates = [...candidatesByCity.values()].flat();
  const allIds = allCandidates.map((v) => String(v.id));

  const cacheByVenueId = await lookupFitCache(admin, allIds, request);
  console.log(
    `[generate-tour-plan] stage 3 cache hits: ${cacheByVenueId.size}/${allIds.length}`,
  );

  const chunks = buildCurateChunks(candidatesByCity, cacheByVenueId);
  console.log(
    `[generate-tour-plan] stage 3 chunks: ${chunks.length} ` +
      `(${chunks.map((c) => `${c.city}:${c.candidates.length}`).join(", ")})`,
  );

  // id -> match_reason for venues freshly kept across ALL chunks this call.
  const freshKeptById = new Map<string, string>();
  // Every candidate id that was actually sent to the LLM in some chunk this
  // request (kept or dropped) — used both to write scoped cache verdicts and
  // to drive the completeness safeguard below.
  const freshEvaluatedIds = new Set<string>();
  const allVerdicts: FitCacheRow[] = [];

  if (chunks.length > 0) {
    const chunkResults = await mapWithConcurrency(
      chunks,
      CURATE_CONCURRENCY,
      (chunk) => curateChunk(client, request, chunk),
    );

    chunks.forEach((chunk, i) => {
      const keptById = chunkResults[i];
      for (const [id, reason] of keptById) {
        if (!freshKeptById.has(id)) freshKeptById.set(id, reason);
      }
      // Write a verdict for every candidate THIS chunk actually received —
      // never for a candidate elsewhere in the corridor this call never saw.
      // This is what keeps a future partial-evaluation bug of this same
      // shape scoped to the one city/chunk it touches instead of poisoning
      // the whole corridor's cache the way the original bug did.
      for (const cand of chunk.candidates) {
        const id = String(cand.id);
        freshEvaluatedIds.add(id);
        allVerdicts.push({
          venue_id: id,
          fits: keptById.has(id),
          match_reason: keptById.get(id) ?? null,
        });
      }
    });

    await writeFitCache(admin, request, allVerdicts);
  }

  // Combine cache hits (fits=true only) with fresh keeps into one reason map,
  // then assemble survivors per city in the SAME order Stage 2 handed them —
  // exactly the same assembly this function always did, just sourced from
  // cache-or-fresh instead of fresh-only.
  const combinedReasonById = new Map<string, string>();
  for (const [id, row] of cacheByVenueId) {
    if (row.fits && row.match_reason) combinedReasonById.set(id, row.match_reason);
  }
  for (const [id, reason] of freshKeptById) combinedReasonById.set(id, reason);

  // Completeness safeguard: any city with real Stage-2 candidates that ends
  // up with ZERO verdicts (cached or fresh) covering any of them was never
  // actually evaluated by anything — the same silent-skip failure class as
  // the bug this chunking fixes, however it happened this time. A city
  // genuinely having nothing worth keeping is normal and silent; a city
  // never being looked at is not, and must be loud.
  const verdictIds = new Set<string>([...cacheByVenueId.keys(), ...freshEvaluatedIds]);
  for (const [city, candidates] of candidatesByCity) {
    if (candidates.length === 0) continue;
    const hasAnyVerdict = candidates.some((v) => verdictIds.has(String(v.id)));
    if (!hasAnyVerdict) {
      console.error(
        `[generate-tour-plan] STAGE 3 SILENT-SKIP BUG: city "${city}" had ${candidates.length} ` +
          `stage-2 candidates but received ZERO verdicts (kept or dropped) from cache or the LLM. ` +
          `This is the same failure class as the 2026-09 multi-city silent-partial-evaluation bug ` +
          `resurfacing in a different shape — investigate before trusting this response for this city.`,
      );
    }
  }

  const out = new Map<string, OutVenue[]>();
  for (const [city, candidates] of candidatesByCity) {
    const survivors: OutVenue[] = [];
    for (const v of candidates) {
      const reason = combinedReasonById.get(String(v.id));
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
      VENUE_CHARACTER_KEYWORDS[v.value.venue_character].textKeywords
        .concat(GOAL_KEYWORDS[v.value.goal]),
    ),
  ];
  const aboutKeywords = [
    ...new Set(
      VENUE_CHARACTER_KEYWORDS[v.value.venue_character].aboutTags
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
    curatedByCity = await curateMatches(anthropic, admin, v.value, candidatesByCity);
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
      (venue) => !isStadiumScaleMismatch(venue, v.value.venue_character),
    )
  );
  const venues = roundRobinCap(perCity, MAX_VENUES);

  return json({ cities: queryCities, venues });
});
