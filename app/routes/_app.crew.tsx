import { useState, useEffect, useRef } from "react";
import { redirect, useLoaderData, useFetcher, Form } from "react-router";
import type { Route } from "./+types/_app.crew";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

const PAGE_SIZE = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

type CrewProfile = {
  id: string;
  name: string | null;
  slug: string | null;
  avatar_url: string | null;
  city: string | null;
  user_type: string | null;
  profile_skills: Array<{
    skills: { name: string; category: string } | null;
  }>;
};

type LoaderData =
  | { access: "featured"; profiles: CrewProfile[]; growStarterPriceId: string }
  | { access: "full"; profiles: CrewProfile[]; total: number; categories: string[] };

type ActionData = { profiles: CrewProfile[]; total: number };

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchProfiles(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  {
    q,
    category,
    city,
    page,
  }: { q: string; category: string; city: string; page: number }
): Promise<{ profiles: CrewProfile[]; total: number }> {
  const offset = (page - 1) * PAGE_SIZE;

  // If filtering by category, first resolve profile IDs that have that skill
  let categoryProfileIds: string[] | null = null;
  if (category) {
    const { data: skillRows } = await supabase
      .from("skills")
      .select("id")
      .eq("category", category);

    const skillIds = skillRows?.map((s: { id: string }) => s.id) ?? [];

    if (skillIds.length === 0) {
      return { profiles: [], total: 0 };
    }

    const { data: psRows } = await supabase
      .from("profile_skills")
      .select("profile_id")
      .in("skill_id", skillIds);

    categoryProfileIds = [
      ...new Set((psRows ?? []).map((r: { profile_id: string }) => r.profile_id)),
    ];

    if (categoryProfileIds.length === 0) {
      return { profiles: [], total: 0 };
    }
  }

  let query = supabase
    .from("profiles")
    .select(
      "id, name, slug, avatar_url, city, user_type, profile_skills ( skill_id, skills ( name, category ) )",
      { count: "exact" }
    )
    .eq("is_published", true)
    .eq("user_type", "member")
    .order("name", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  if (q) {
    query = query.or(`name.ilike.%${q}%,slug.ilike.%${q}%,city.ilike.%${q}%`);
  }
  if (city) {
    query = query.ilike("city", `%${city}%`);
  }
  if (categoryProfileIds !== null) {
    query = query.in("id", categoryProfileIds);
  }

  const { data, count, error } = await query;

  if (error) {
    console.error("fetchProfiles error:", error.message);
    return { profiles: [], total: 0 };
  }

  return { profiles: (data ?? []) as CrewProfile[], total: count ?? 0 };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return redirect("/login", { headers: responseHeaders });

  // Check plan access
  const userProfile = await getCurrentProfile(supabase, session.user.id);

  let crewAccess = "featured";
  if (userProfile?.plan_id) {
    const { data: plan } = await supabase
      .from("plans")
      .select("crew_access")
      .eq("id", userProfile.plan_id)
      .maybeSingle();
    crewAccess = (plan?.crew_access as string) ?? "featured";
  }

  // Featured-only access (no plan or crew_access = 'featured')
  if (crewAccess !== "full") {
    const { data: featuredProfiles } = await supabase
      .from("profiles")
      .select(
        "id, name, slug, avatar_url, city, user_type, profile_skills ( skill_id, skills ( name, category ) )"
      )
      .eq("is_published", true)
      .eq("is_featured", true)
      .order("name", { ascending: true });

    return Response.json<LoaderData>(
      {
        access: "featured",
        profiles: (featuredProfiles ?? []) as CrewProfile[],
        growStarterPriceId: process.env.STRIPE_GROW_STARTER_PRICE_ID ?? "",
      },
      { headers: responseHeaders }
    );
  }

  // Full access — load categories and first page in parallel
  const [{ profiles, total }, categoriesResult] = await Promise.all([
    fetchProfiles(supabase, { q: "", category: "", city: "", page: 1 }),
    supabase.from("skills").select("category").eq("is_visible", true),
  ]);

  const categories = [
    ...new Set(
      (categoriesResult.data ?? []).map((r: { category: string }) => r.category)
    ),
  ].sort() as string[];

  return Response.json<LoaderData>(
    { access: "full", profiles, total, categories },
    { headers: responseHeaders }
  );
}

// ─── Action — search / filter ─────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const supabase = createSupabaseServerClient(request);

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return Response.json<ActionData>({ profiles: [], total: 0 }, { status: 401 });

  const formData = await request.formData();
  const q = (formData.get("q") as string) ?? "";
  const category = (formData.get("category") as string) ?? "";
  const city = (formData.get("city") as string) ?? "";
  const page = Math.max(1, parseInt((formData.get("page") as string) ?? "1", 10));

  const result = await fetchProfiles(supabase, { q, category, city, page });
  return Response.json<ActionData>(result);
}

// ─── Featured grid (no plan / crew_access = 'featured') ──────────────────────

function FeaturedGrid({ profiles, growStarterPriceId }: { profiles: CrewProfile[]; growStarterPriceId: string }) {

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "36px 24px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 16,
          marginBottom: 28,
        }}
      >
        <div>
          <h1 style={{ color: "#ffffff", fontSize: 24, fontWeight: 700, marginBottom: 6 }}>
            Crew
          </h1>
          <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 15, margin: 0 }}>
            Featured creatives available for hire.
          </p>
        </div>

        {/* Upgrade to Grow — unlocks full crew search */}
        <Form method="post" action="/api/stripe/checkout">
          <input type="hidden" name="price_id" value={growStarterPriceId} />
          <button
            type="submit"
            style={{
              padding: "11px 20px",
              background: "#F5A623",
              color: "#111111",
              border: "none",
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Upgrade to Grow — unlock full crew →
          </button>
        </Form>
      </div>

      {profiles.length === 0 ? (
        <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 14 }}>No featured profiles yet.</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 14,
          }}
        >
          {profiles.map((p) => (
            <ProfileCard key={p.id} profile={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Profile card ─────────────────────────────────────────────────────────────

function ProfileCard({ profile }: { profile: CrewProfile }) {
  const skills = profile.profile_skills
    .map((ps) => ps.skills)
    .filter(Boolean) as { name: string; category: string }[];

  const visibleSkills = skills.slice(0, 4);
  const extraCount = skills.length - visibleSkills.length;

  const initials = (profile.name ?? profile.slug ?? "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <a
      href={`https://${profile.slug}.sqrz.com`}
      target="_blank"
      rel="noopener noreferrer"
      style={{ textDecoration: "none" }}
    >
      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 14,
          padding: "18px 16px",
          cursor: "pointer",
          transition: "border-color 0.15s",
          height: "100%",
        }}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLDivElement).style.borderColor = "rgba(245,166,35,0.4)")
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.07)")
        }
      >
        {/* Avatar */}
        {profile.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt={profile.name ?? ""}
            style={{
              width: 52,
              height: 52,
              borderRadius: "50%",
              objectFit: "cover",
              marginBottom: 12,
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: "50%",
              background: "rgba(245,166,35,0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              fontWeight: 700,
              color: "#F5A623",
              marginBottom: 12,
            }}
          >
            {initials}
          </div>
        )}

        {/* Name */}
        <div style={{ color: "#ffffff", fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
          {profile.name ?? profile.slug}
        </div>

        {/* Slug */}
        {profile.slug && (
          <div style={{ color: "#F5A623", fontSize: 11, marginBottom: 6, opacity: 0.7 }}>
            {profile.slug}.sqrz.com
          </div>
        )}

        {/* City */}
        {profile.city && (
          <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, marginBottom: 10 }}>
            📍 {profile.city}
          </div>
        )}

        {/* Skills */}
        {visibleSkills.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {visibleSkills.map((s) => (
              <span
                key={s.name}
                style={{
                  fontSize: 11,
                  background: "rgba(245,166,35,0.1)",
                  color: "#F5A623",
                  borderRadius: 4,
                  padding: "2px 7px",
                }}
              >
                {s.name}
              </span>
            ))}
            {extraCount > 0 && (
              <span
                style={{
                  fontSize: 11,
                  color: "rgba(255,255,255,0.3)",
                  padding: "2px 4px",
                }}
              >
                +{extraCount}
              </span>
            )}
          </div>
        )}
      </div>
    </a>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Crew() {
  const loaderData = useLoaderData<typeof loader>() as LoaderData;

  if (loaderData.access === "featured") return <FeaturedGrid profiles={loaderData.profiles} growStarterPriceId={loaderData.growStarterPriceId} />;

  const { profiles: initialProfiles, total: initialTotal, categories } = loaderData;

  const fetcher = useFetcher<ActionData>();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [city, setCity] = useState("");
  const [page, setPage] = useState(1);

  const profiles = fetcher.data?.profiles ?? initialProfiles;
  const total = fetcher.data?.total ?? initialTotal;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const isSearching = fetcher.state !== "idle";

  function submit(params: { q: string; category: string; city: string; page: number }) {
    fetcher.submit(
      {
        q: params.q,
        category: params.category,
        city: params.city,
        page: String(params.page),
      },
      { method: "POST" }
    );
  }

  // Debounce text search
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      submit({ q, category, city, page: 1 });
    }, 300);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function handleCategoryChange(val: string) {
    setCategory(val);
    setPage(1);
    submit({ q, category: val, city, page: 1 });
  }

  function handleCityChange(val: string) {
    setCity(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      submit({ q, category, city: val, page: 1 });
    }, 300);
  }

  function goToPage(newPage: number) {
    setPage(newPage);
    submit({ q, category, city, page: newPage });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const inputBase: React.CSSProperties = {
    background: "#1a1a1a",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 10,
    color: "#ffffff",
    fontSize: 14,
    padding: "10px 14px",
    outline: "none",
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "36px 24px" }}>
      {/* Header */}
      <h1 style={{ color: "#ffffff", fontSize: 24, fontWeight: 700, marginBottom: 6 }}>
        Crew
      </h1>
      <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 15, marginBottom: 28 }}>
        Search and hire verified creatives for your next gig.
      </p>

      {/* Search + filters */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          marginBottom: 20,
        }}
      >
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, handle, city…"
          style={{ ...inputBase, flex: "1 1 240px", minWidth: 0 }}
        />

        <select
          value={category}
          onChange={(e) => handleCategoryChange(e.target.value)}
          style={{ ...inputBase, flex: "0 1 180px", cursor: "pointer" }}
        >
          <option value="">All categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={city}
          onChange={(e) => handleCityChange(e.target.value)}
          placeholder="Filter by city"
          style={{ ...inputBase, flex: "0 1 160px" }}
        />
      </div>

      {/* Result count */}
      <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, marginBottom: 20 }}>
        {isSearching ? (
          "Searching…"
        ) : (
          <>
            <span style={{ color: "#ffffff", fontWeight: 600 }}>{total}</span>{" "}
            {total === 1 ? "profile" : "profiles"} found
            {totalPages > 1 && (
              <span>
                {" "}· page {page} of {totalPages}
              </span>
            )}
          </>
        )}
      </div>

      {/* Grid */}
      {profiles.length === 0 && !isSearching ? (
        <div
          style={{
            textAlign: "center",
            padding: "64px 24px",
            color: "rgba(255,255,255,0.25)",
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
          <p style={{ fontSize: 14, margin: 0 }}>No profiles match your search.</p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 14,
            opacity: isSearching ? 0.5 : 1,
            transition: "opacity 0.15s",
          }}
        >
          {profiles.map((profile) => (
            <ProfileCard key={profile.id} profile={profile} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            marginTop: 36,
          }}
        >
          <button
            onClick={() => goToPage(page - 1)}
            disabled={page <= 1}
            style={{
              background: "none",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 8,
              color: page <= 1 ? "rgba(255,255,255,0.2)" : "#ffffff",
              fontSize: 14,
              padding: "8px 16px",
              cursor: page <= 1 ? "default" : "pointer",
            }}
          >
            ← Previous
          </button>

          <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
            {page} / {totalPages}
          </span>

          <button
            onClick={() => goToPage(page + 1)}
            disabled={page >= totalPages}
            style={{
              background: "none",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 8,
              color: page >= totalPages ? "rgba(255,255,255,0.2)" : "#ffffff",
              fontSize: 14,
              padding: "8px 16px",
              cursor: page >= totalPages ? "default" : "pointer",
            }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
