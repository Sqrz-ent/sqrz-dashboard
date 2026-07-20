import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.crew";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

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
};

type LoaderData = {
  access: "full";
  profiles: CrewProfile[];
  total: number;
  isAdmin: boolean;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Directory query: everyone sees completed member profiles; is_beta admins also
// see unpublished/draft profiles (same filter semantics as the pre-roster page).
async function fetchProfiles(
  supabase: ReturnType<typeof createSupabaseServerClient>["supabase"],
  includeUnpublished: boolean
): Promise<{ profiles: CrewProfile[]; total: number }> {
  let query = supabase
    .from("profiles")
    .select(
      "id, name, slug, avatar_url, city, user_type, is_published, is_claimed, onboarding_completed, claim_token",
      { count: "exact" }
    )
    .eq("user_type", "member")
    .order("name", { ascending: true });

  if (!includeUnpublished) {
    query = query.eq("onboarding_completed", true);
    query = query.or("is_claimed.eq.true,claim_token.is.null");
  } else {
    query = query.or("onboarding_completed.eq.true,is_claimed.eq.false");
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

  const { profiles, total } = await fetchProfiles(supabase, isAdmin);

  return Response.json(
    { access: "full", profiles: sanitizeProfilesForViewer(profiles, isAdmin), total, isAdmin },
    { headers }
  );
}

// ─── Profile card ─────────────────────────────────────────────────────────────

function ProfileCard({ profile, isAdmin }: { profile: CrewProfile; isAdmin: boolean }) {
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
      </div>
    </a>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Crew() {
  const loaderData = useLoaderData<typeof loader>() as LoaderData;
  const { profiles, total, isAdmin } = loaderData;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "36px 24px" }}>
      {/* Header */}
      <h1 style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, margin: "0 0 6px" }}>
        Crew
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 28 }}>
        {isAdmin
          ? "Completed member profiles and Crew-created drafts."
          : "Published creatives on SQRZ."}
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
          <p style={{ fontSize: 14, margin: 0 }}>No profiles yet.</p>
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
            <ProfileCard key={profile.id} profile={profile} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}
