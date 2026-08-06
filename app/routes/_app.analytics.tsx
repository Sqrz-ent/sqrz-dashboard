import { redirect } from "react-router";
import type { Route } from "./+types/_app.analytics";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import GetTheAppSection from "~/components/GetTheAppSection";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// TODO: swap in the real HubSpot meeting scheduler link for planning a large /
// managed multi-channel campaign (boost_campaigns.is_managed = true, wire
// transfer — see BoostView.swift / _app.boost.tsx's old request_managed intent
// on iOS/the pre-collapse web flow for that path's shape).
const HUBSPOT_SCHEDULER_URL = "#";

// The Grow section (post-reframe, 2026-08-06): web dashboard is maintenance-
// mode back office, iOS is primary. Self-serve Boost creation, the ad-spend
// wallet top-up, the private-link CRUD, and the analytics dashboards that used
// to live here are all iOS-only now — this page is just a promo surface: get
// the app, or talk to us about a managed campaign. See CLAUDE.md "Known Open
// Issues" for what still points here (bookmarks to the old /boost, /links
// routes redirect to this page now).
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  return Response.json({}, { headers });
}

export default function AnalyticsPage() {
  return (
    <div
      style={{
        padding: "28px 20px 60px",
        maxWidth: 640,
        margin: "0 auto",
        fontFamily: FONT_BODY,
        color: "var(--text)",
      }}
    >
      <h1
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 38,
          fontWeight: 800,
          color: ACCENT,
          textTransform: "uppercase",
          letterSpacing: "0.03em",
          margin: "0 0 8px",
          lineHeight: 1,
        }}
      >
        Grow
      </h1>
      <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 32px", lineHeight: 1.6 }}>
        Campaigns, results, and the ad-spend wallet now live in the SQRZ iOS app.
      </p>

      <GetTheAppSection />

      {/* Large Boost / managed campaigns — wire-transfer flow, contact SQRZ directly */}
      <div
        style={{
          marginTop: 32,
          textAlign: "center",
          padding: "24px 20px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
        }}
      >
        <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 6px" }}>
          Planning a multi-channel campaign?
        </p>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", lineHeight: 1.6 }}>
          Talk to us about a larger, managed Boost campaign across multiple channels.
        </p>
        <a
          href={HUBSPOT_SCHEDULER_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 24px",
            background: "transparent",
            color: ACCENT,
            border: `1px solid ${ACCENT}`,
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 700,
            textDecoration: "none",
            fontFamily: FONT_BODY,
          }}
        >
          Book a call →
        </a>
      </div>
    </div>
  );
}
