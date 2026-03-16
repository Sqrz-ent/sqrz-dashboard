import { redirect, useLoaderData, Link } from "react-router";
import type { Route } from "./+types/_app._index";
import { createSupabaseServerClient } from "~/lib/supabase.server";

export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) return redirect("/join");

  const { data: profile } = await supabase
    .from("profiles")
    .select("name, slug, is_published, avatar_url")
    .eq("id", session.user.id)
    .maybeSingle();

  return Response.json({ profile }, { headers: responseHeaders });
}

// ─── Placeholder cards ────────────────────────────────────────────────────────

function Card({
  title,
  description,
  to,
  comingSoon,
}: {
  title: string;
  description: string;
  to: string;
  comingSoon?: boolean;
}) {
  const inner = (
    <div
      style={{
        background: "#1a1a1a",
        border: "1px solid rgba(245,166,35,0.18)",
        borderRadius: 16,
        padding: "20px 22px",
        height: "100%",
        opacity: comingSoon ? 0.5 : 1,
        cursor: comingSoon ? "default" : "pointer",
        transition: "border-color 0.15s",
      }}
    >
      <h2 style={{ color: "#ffffff", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
        {title}
      </h2>
      <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, margin: 0 }}>
        {description}
      </p>
      {comingSoon && (
        <span
          style={{
            display: "inline-block",
            marginTop: 10,
            fontSize: 11,
            color: "#F5A623",
            border: "1px solid rgba(245,166,35,0.4)",
            borderRadius: 4,
            padding: "2px 6px",
          }}
        >
          Coming soon
        </span>
      )}
    </div>
  );

  if (comingSoon) return <div>{inner}</div>;
  return (
    <Link to={to} style={{ textDecoration: "none" }}>
      {inner}
    </Link>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardIndex() {
  const { profile } = useLoaderData<typeof loader>();

  const profileSlug = (profile as Record<string, unknown>)?.slug as string | undefined;
  const profileName = (profile as Record<string, unknown>)?.name as string | undefined;
  const isPublished = (profile as Record<string, unknown>)?.is_published as boolean | undefined;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "36px 24px" }}>
      {/* Header */}
      <h1 style={{ color: "#ffffff", fontSize: 24, fontWeight: 700, marginBottom: 6 }}>
        Welcome to SQRZ{profileName ? `, ${profileName}` : ""}
      </h1>

      {profileSlug && (
        <a
          href={`https://${profileSlug}.sqrz.com`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#F5A623", fontSize: 14, fontWeight: 500, textDecoration: "none" }}
        >
          {profileSlug}.sqrz.com →
        </a>
      )}

      {/* Published status */}
      <div style={{ marginTop: 16, marginBottom: 36 }}>
        {isPublished ? (
          <span style={{ color: "#4ade80", fontSize: 13, fontWeight: 500 }}>
            ✓ Your profile is live
          </span>
        ) : (
          <Link
            to="/profile"
            style={{ color: "#F5A623", fontSize: 13, fontWeight: 500, textDecoration: "none" }}
          >
            Publish your profile →
          </Link>
        )}
      </div>

      {/* Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 14,
        }}
      >
        <Card
          title="📋 Pipeline"
          description="Manage booking requests, pending gigs, and confirmed work."
          to="/office"
          comingSoon
        />
        <Card
          title="👤 Profile"
          description="Edit your bio, skills, services, and public profile."
          to="/profile"
        />
        <Card
          title="🖼 Media"
          description="Upload photos and videos to your gallery."
          to="/media"
          comingSoon
        />
        <Card
          title="⚙️ Account"
          description="Subscription, billing, and account settings."
          to="/account"
          comingSoon
        />
      </div>
    </div>
  );
}
