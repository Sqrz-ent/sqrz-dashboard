import { useState, useEffect, useRef } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.crew";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase as browserSupabase } from "~/lib/supabase.client";

const AGENT_PROFILE_ID = "8fc5755f-8e1b-47ce-b971-641860458bd0";

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
  onboarding_completed: boolean | null;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchRoster(
  supabase: ReturnType<typeof createSupabaseServerClient>["supabase"]
): Promise<CrewProfile[]> {
  const { data, error } = await supabase.rpc("get_agent_roster", {
    p_agent_profile_id: AGENT_PROFILE_ID,
  });

  if (error) {
    console.error("get_agent_roster error:", error.message);
    return [];
  }

  // Map roster rows onto the CrewProfile shape the cards render. The RPC has no
  // city/skills columns, so those are nulled out.
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.profile_id as string,
    name: (r.name as string | null) ?? null,
    slug: (r.slug as string | null) ?? null,
    avatar_url: (r.avatar_url as string | null) ?? null,
    city: null,
    user_type: (r.user_type as string | null) ?? null,
    is_published: (r.is_published as boolean | null) ?? null,
    is_claimed: (r.is_claimed as boolean | null) ?? null,
    onboarding_completed: null,
    claim_token: (r.claim_token as string | null) ?? null,
    profile_skills: [],
  }));
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

  const profiles = await fetchRoster(supabase);

  return Response.json(
    { access: "full", profiles: sanitizeProfilesForViewer(profiles, isAdmin), total: profiles.length, isAdmin },
    { headers }
  );
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

  const [claimCode, setClaimCode] = useState<{
    name: string;
    slug: string;
    claimUrl: string;
    fromCreate?: boolean;
  } | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createSlug, setCreateSlug] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
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
        setSlugError(null);
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

  // Real-time slug availability check — debounced, runs as the user types.
  const slugCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function checkSlug(value: string) {
    const slug = value.trim();
    if (!slug) {
      setSlugError(null);
      return;
    }
    const { data } = await browserSupabase
      .from("profiles")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (data) setSlugError("Slug already taken");
  }

  function scheduleSlugCheck(value: string) {
    if (slugCheckTimer.current) clearTimeout(slugCheckTimer.current);
    if (!value.trim()) {
      setSlugError(null);
      return;
    }
    slugCheckTimer.current = setTimeout(() => checkSlug(value), 400);
  }

  function handleCreate() {
    if (!createSlug.trim() || slugError) return;
    setCreateError(null);
    createFetcher.submit(
      { slug: createSlug },
      { method: "POST", action: "/api/crew/create-profile" }
    );
  }

  const profiles = initialProfiles;
  const total = initialTotal;

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
            onClick={() => { setShowCreateModal(true); setCreateError(null); setCreateSlug(""); setSlugError(null); }}
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
          ? "Your managed roster and Crew-created drafts."
          : "Your managed roster."}
      </p>

      {/* Result count */}
      <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 20 }}>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>{total}</span>{" "}
        {total === 1 ? "profile" : "profiles"}
      </div>

      {/* Grid */}
      {profiles.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "64px 24px",
            color: "var(--text-muted)",
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 12 }}>👥</div>
          <p style={{ fontSize: 14, margin: 0 }}>No profiles in the roster yet.</p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 14,
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
                  onChange={(e) => {
                    const next = sanitizeSlugInput(e.target.value);
                    setCreateSlug(next);
                    setCreateError(null);
                    setSlugError(null);
                    scheduleSlugCheck(next);
                  }}
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

            {(slugError || createError) && (
              <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>
                {slugError || createError}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!createSlug.trim() || isCreating || !!slugError}
                style={{
                  background: !createSlug.trim() || isCreating || slugError ? "rgba(245,166,35,0.4)" : "#F5A623",
                  color: "#111111",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 18px",
                  cursor: !createSlug.trim() || isCreating || slugError ? "default" : "pointer",
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
