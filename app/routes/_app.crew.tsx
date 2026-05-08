import { useState, useEffect, useRef } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
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
  is_published: boolean | null;
  is_claimed: boolean | null;
  claim_token: string | null;
  profile_skills: Array<{
    skills: { name: string; category: string } | null;
  }>;
};

type LoaderData = {
  access: "full";
  profiles: CrewProfile[];
  total: number;
  isAdmin: boolean;
};

type ActionData = { profiles: CrewProfile[]; total: number };

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchProfiles(
  supabase: ReturnType<typeof createSupabaseServerClient>["supabase"],
  {
    q,
    category,
    city,
    page,
    includeUnpublished,
  }: { q: string; category: string; city: string; page: number; includeUnpublished: boolean }
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
      "id, name, slug, avatar_url, city, user_type, is_published, is_claimed, claim_token, profile_skills ( skill_id, skills ( name, category ) )",
      { count: "exact" }
    )
    .eq("user_type", "member")
    .order("name", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  if (!includeUnpublished) {
    query = query.eq("is_published", true);
  }

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

  return { profiles: (data ?? []) as unknown as CrewProfile[], total: count ?? 0 };
}

function sanitizeProfilesForViewer(profiles: CrewProfile[], isAdmin: boolean): CrewProfile[] {
  if (isAdmin) return profiles;

  return profiles.map((profile) => ({
    ...profile,
    claim_token: null,
    is_claimed: null,
  }));
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  // Check plan access
  const userProfile = await getCurrentProfile(supabase, user.id);
  const isAdmin = Boolean(userProfile?.is_beta);

  const { profiles, total } = await fetchProfiles(supabase, {
    q: "",
    category: "",
    city: "",
    page: 1,
    includeUnpublished: isAdmin,
  });

  return Response.json(
    { access: "full", profiles: sanitizeProfilesForViewer(profiles, isAdmin), total, isAdmin },
    { headers }
  );
}

// ─── Action — search / filter ─────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const { supabase } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ profiles: [], total: 0 }, { status: 401 });
  const userProfile = await getCurrentProfile(supabase, user.id);
  const isAdmin = Boolean(userProfile?.is_beta);

  const formData = await request.formData();
  const q = (formData.get("q") as string) ?? "";
  const category = (formData.get("category") as string) ?? "";
  const city = (formData.get("city") as string) ?? "";
  const page = Math.max(1, parseInt((formData.get("page") as string) ?? "1", 10));

  const result = await fetchProfiles(supabase, {
    q,
    category,
    city,
    page,
    includeUnpublished: isAdmin,
  });
  return Response.json({
    profiles: sanitizeProfilesForViewer(result.profiles, isAdmin),
    total: result.total,
  });
}

// ─── Profile card ─────────────────────────────────────────────────────────────

function ProfileCard({
  profile,
  isAdmin,
  onShowClaimCode,
}: {
  profile: CrewProfile;
  isAdmin: boolean;
  onShowClaimCode: (payload: { name: string; slug: string; claimUrl: string }) => void;
}) {
  const skills = profile.profile_skills
    .map((ps) => ps.skills)
    .filter(Boolean) as { name: string; category: string }[];

  const visibleSkills = skills.slice(0, 4);
  const extraCount = skills.length - visibleSkills.length;
  const claimUrl =
    !profile.is_published && profile.slug && profile.claim_token
      ? `https://${profile.slug}.sqrz.com?claim=${encodeURIComponent(profile.claim_token)}`
      : null;

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
          background: "var(--surface)",
          border: "1px solid var(--border)",
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
          ((e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)")
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
        <div style={{ color: "var(--text)", fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
          {profile.name ?? profile.slug}
        </div>

        {isAdmin && (
          <div style={{ marginBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                borderRadius: 999,
                padding: "3px 7px",
                background: profile.is_published ? "rgba(74,222,128,0.14)" : "rgba(245,166,35,0.14)",
                color: profile.is_published ? "#4ade80" : "#F5A623",
              }}
            >
              {profile.is_published ? "Published" : "Draft"}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                borderRadius: 999,
                padding: "3px 7px",
                background: profile.is_claimed ? "rgba(74,222,128,0.14)" : "rgba(96,165,250,0.14)",
                color: profile.is_claimed ? "#4ade80" : "#60a5fa",
              }}
            >
              {profile.is_claimed ? "Claimed" : "Claim profile"}
            </span>
          </div>
        )}

        {/* Slug */}
        {profile.slug && (
          <div style={{ color: "#F5A623", fontSize: 11, marginBottom: 6, opacity: 0.7 }}>
            {profile.slug}.sqrz.com
          </div>
        )}

        {/* City */}
        {profile.city && (
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
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
                  color: "var(--text-muted)",
                  padding: "2px 4px",
                }}
              >
                +{extraCount}
              </span>
            )}
          </div>
        )}

        {isAdmin && claimUrl && (
          <div
            onClick={(event) => event.preventDefault()}
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--border)",
              display: "flex",
            }}
          >
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                onShowClaimCode({
                  name: profile.name ?? profile.slug ?? "Profile",
                  slug: profile.slug ?? "",
                  claimUrl,
                });
              }}
              style={{
                background: "#F5A623",
                color: "#111111",
                border: "none",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                padding: "9px 10px",
                cursor: "pointer",
                width: "100%",
              }}
            >
              Show code
            </button>
          </div>
        )}
      </div>
    </a>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Crew() {
  const loaderData = useLoaderData<typeof loader>() as LoaderData;
  const { profiles: initialProfiles, total: initialTotal, isAdmin } = loaderData;

  const fetcher = useFetcher<ActionData>();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [claimCode, setClaimCode] = useState<{
    name: string;
    slug: string;
    claimUrl: string;
    fromCreate?: boolean;
  } | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createSlug, setCreateSlug] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const createFetcher = useFetcher<{ slug: string; claim_token: string; claim_url: string; error?: string }>();

  const isCreating = createFetcher.state !== "idle";

  useEffect(() => {
    if (createFetcher.state === "idle" && createFetcher.data) {
      if (createFetcher.data.error) {
        setCreateError(createFetcher.data.error);
      } else if (createFetcher.data.claim_url) {
        setShowCreateModal(false);
        setCreateSlug("");
        setCreateError(null);
        setClaimCode({
          name: createFetcher.data.slug,
          slug: createFetcher.data.slug,
          claimUrl: createFetcher.data.claim_url,
          fromCreate: true,
        });
      }
    }
  }, [createFetcher.state, createFetcher.data]);

  function sanitizeSlugInput(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }

  function handleCreate() {
    if (!createSlug.trim()) return;
    setCreateError(null);
    createFetcher.submit(
      { slug: createSlug },
      { method: "POST", action: "/api/crew/create-profile" }
    );
  }

  const profiles = fetcher.data?.profiles ?? initialProfiles;
  const total = fetcher.data?.total ?? initialTotal;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const isSearching = fetcher.state !== "idle";

  function clearDebounce() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }

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
    clearDebounce();
    debounceRef.current = setTimeout(() => {
      setPage(1);
      submit({ q, category: "", city: "", page: 1 });
    }, 300);
    return clearDebounce;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function goToPage(newPage: number) {
    setPage(newPage);
    submit({ q, category: "", city: "", page: newPage });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const inputBase: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text)",
    fontSize: 14,
    padding: "10px 14px",
    outline: "none",
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "36px 24px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
        <h1 style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, margin: 0 }}>
          Crew
        </h1>
        {isAdmin && (
          <button
            type="button"
            onClick={() => { setShowCreateModal(true); setCreateError(null); setCreateSlug(""); }}
            style={{
              background: "#F5A623",
              color: "#111111",
              border: "none",
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 700,
              padding: "9px 14px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            + Create Profile
          </button>
        )}
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 28 }}>
        {isAdmin
          ? "Search across all member profiles, including drafts and unpublished profiles."
          : "Search and hire published creatives for your next gig."}
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
          placeholder="Search by name or handle…"
          style={{ ...inputBase, flex: "1 1 240px", minWidth: 0 }}
        />
      </div>

      {/* Result count */}
      <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 20 }}>
        {isSearching ? (
          "Searching…"
        ) : (
          <>
            <span style={{ color: "var(--text)", fontWeight: 600 }}>{total}</span>{" "}
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
            color: "var(--text-muted)",
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
            <ProfileCard
              key={profile.id}
              profile={profile}
              isAdmin={isAdmin}
              onShowClaimCode={setClaimCode}
            />
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
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: page <= 1 ? "var(--text-muted)" : "var(--text)",
              fontSize: 14,
              padding: "8px 16px",
              cursor: page <= 1 ? "default" : "pointer",
            }}
          >
            ← Previous
          </button>

          <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
            {page} / {totalPages}
          </span>

          <button
            onClick={() => goToPage(page + 1)}
            disabled={page >= totalPages}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: page >= totalPages ? "var(--text-muted)" : "var(--text)",
              fontSize: 14,
              padding: "8px 16px",
              cursor: page >= totalPages ? "default" : "pointer",
            }}
          >
            Next →
          </button>
        </div>
      )}

      {/* ── Create Profile Modal ─────────────────────────────────────────────── */}
      {showCreateModal && (
        <div
          onClick={() => setShowCreateModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 200,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 400,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 18,
              padding: 24,
              boxShadow: "0 24px 60px rgba(0,0,0,0.26)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
              <div>
                <div style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
                  Create profile
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  Creates a draft profile with a claim link.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 22,
                  lineHeight: 1,
                  cursor: "pointer",
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div style={{ marginBottom: 6 }}>
              <label style={{ color: "var(--text-muted)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                Slug
              </label>
              <div style={{ display: "flex", alignItems: "center", background: "var(--surface-muted)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                <input
                  type="text"
                  value={createSlug}
                  onChange={(e) => { setCreateSlug(sanitizeSlugInput(e.target.value)); setCreateError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && createSlug.trim()) handleCreate(); }}
                  placeholder="handle"
                  autoFocus
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: "none",
                    color: "var(--text)",
                    fontSize: 14,
                    padding: "10px 12px",
                    outline: "none",
                  }}
                />
                <span style={{ color: "var(--text-muted)", fontSize: 13, padding: "10px 12px 10px 0", whiteSpace: "nowrap" }}>.sqrz.com</span>
              </div>
              {createSlug && (
                <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 5 }}>
                  {createSlug}.sqrz.com?claim=…
                </div>
              )}
            </div>

            {createError && (
              <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>
                {createError}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!createSlug.trim() || isCreating}
                style={{
                  background: !createSlug.trim() || isCreating ? "rgba(245,166,35,0.4)" : "#F5A623",
                  color: "#111111",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 18px",
                  cursor: !createSlug.trim() || isCreating ? "default" : "pointer",
                  flex: 1,
                }}
              >
                {isCreating ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                style={{
                  background: "transparent",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 14px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {claimCode && (
        <div
          onClick={() => setClaimCode(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 200,
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 460,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 18,
              padding: 24,
              boxShadow: "0 24px 60px rgba(0,0,0,0.26)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
              <div>
                <div style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
                  Claim code
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  {claimCode.fromCreate
                    ? `Share this link with @${claimCode.slug} to claim their profile.`
                    : `${claimCode.name}${claimCode.slug ? ` · ${claimCode.slug}.sqrz.com` : ""}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setClaimCode(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 22,
                  lineHeight: 1,
                  cursor: "pointer",
                }}
                aria-label="Close claim code"
              >
                ×
              </button>
            </div>

            <div
              style={{
                background: "rgba(245,166,35,0.06)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 14,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 8,
                }}
              >
                Claim link
              </div>
              <div
                style={{
                  color: "var(--text)",
                  fontSize: 13,
                  lineHeight: 1.5,
                  wordBreak: "break-all",
                }}
              >
                {claimCode.claimUrl}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(claimCode.claimUrl);
                  } catch {
                    window.prompt("Copy claim link", claimCode.claimUrl);
                  }
                }}
                style={{
                  background: "#F5A623",
                  color: "#111111",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 14px",
                  cursor: "pointer",
                }}
              >
                Copy link
              </button>
              <button
                type="button"
                onClick={() => setClaimCode(null)}
                style={{
                  background: "transparent",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 14px",
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
