import { redirect } from "react-router";
import type { Route } from "./+types/api.dashboard.home-summary";
import { createSupabaseServerClient } from "~/lib/supabase.server";

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? "all";
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .single();

  if (!profile) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  const profileId = profile.id as string;

  if (scope === "primary") {
    const { data: analyticsData } = await supabase
      .from("profile_analytics")
      .select("*")
      .eq("profile_id", profileId)
      .maybeSingle();

    return Response.json({ analytics: analyticsData ?? null }, { headers });
  }

  if (scope === "secondary") {
    const [servicesRes, videosRes, refsRes] = await Promise.all([
      supabase
        .from("profile_services")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profileId),
      supabase
        .from("profile_videos")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profileId),
      supabase
        .from("profile_references")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profileId),
    ]);

    return Response.json(
      {
        hasServices: (servicesRes.count ?? 0) > 0,
        hasVideos: (videosRes.count ?? 0) > 0,
        hasRefs: (refsRes.count ?? 0) > 0,
      },
      { headers }
    );
  }

  const [analyticsRes, servicesRes, videosRes, refsRes] = await Promise.all([
    supabase
      .from("profile_analytics")
      .select("*")
      .eq("profile_id", profileId)
      .maybeSingle(),
    supabase
      .from("profile_services")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
    supabase
      .from("profile_videos")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
    supabase
      .from("profile_references")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
  ]);

  return Response.json(
    {
      analytics: analyticsRes.data ?? null,
      hasServices: (servicesRes.count ?? 0) > 0,
      hasVideos: (videosRes.count ?? 0) > 0,
      hasRefs: (refsRes.count ?? 0) > 0,
    },
    { headers }
  );
}

export default function ApiDashboardHomeSummary() {
  return null;
}
