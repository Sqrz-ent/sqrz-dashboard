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
    const [analyticsRes, activeBookingsRes, upcomingBookingsRes] = await Promise.all([
      supabase
        .from("profile_analytics")
        .select("*")
        .eq("profile_id", profileId)
        .maybeSingle(),
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", profileId)
        .in("status", ["requested", "pending", "confirmed"]),
      supabase
        .from("bookings")
        .select("id, title, service, date_start, city")
        .eq("owner_id", profileId)
        .eq("status", "confirmed")
        .gt("date_start", new Date().toISOString())
        .order("date_start", { ascending: true })
        .limit(3),
    ]);

    return Response.json(
      {
        analytics: analyticsRes.data ?? null,
        activeBookingsCount: activeBookingsRes.count ?? 0,
        upcomingBookings: upcomingBookingsRes.data ?? [],
      },
      { headers }
    );
  }

  if (scope === "secondary") {
    const [servicesRes, videosRes, refsRes, blocksRes, photosRes] = await Promise.all([
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
      supabase
        .from("availability_blocks")
        .select("id, start_date, end_date, label, show_label")
        .eq("profile_id", profileId)
        .order("start_date", { ascending: true }),
      supabase
        .from("profile_photos")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profileId),
    ]);

    return Response.json(
      {
        hasServices: (servicesRes.count ?? 0) > 0,
        hasVideos: (videosRes.count ?? 0) > 0,
        hasRefs: (refsRes.count ?? 0) > 0,
        hasGallery: (photosRes.count ?? 0) > 0,
        availabilityBlocks: blocksRes.data ?? [],
      },
      { headers }
    );
  }

  const [
    analyticsRes,
    activeBookingsRes,
    upcomingBookingsRes,
    servicesRes,
    videosRes,
    refsRes,
    blocksRes,
    photosRes,
  ] = await Promise.all([
    supabase
      .from("profile_analytics")
      .select("*")
      .eq("profile_id", profileId)
      .maybeSingle(),
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", profileId)
      .in("status", ["requested", "pending", "confirmed"]),
    supabase
      .from("bookings")
      .select("id, title, service, date_start, city")
      .eq("owner_id", profileId)
      .eq("status", "confirmed")
      .gt("date_start", new Date().toISOString())
      .order("date_start", { ascending: true })
      .limit(3),
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
    supabase
      .from("availability_blocks")
      .select("id, start_date, end_date, label, show_label")
      .eq("profile_id", profileId)
      .order("start_date", { ascending: true }),
    supabase
      .from("profile_photos")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
  ]);

  return Response.json(
    {
      analytics: analyticsRes.data ?? null,
      activeBookingsCount: activeBookingsRes.count ?? 0,
      upcomingBookings: upcomingBookingsRes.data ?? [],
      hasServices: (servicesRes.count ?? 0) > 0,
      hasVideos: (videosRes.count ?? 0) > 0,
      hasRefs: (refsRes.count ?? 0) > 0,
      hasGallery: (photosRes.count ?? 0) > 0,
      availabilityBlocks: blocksRes.data ?? [],
    },
    { headers }
  );
}

export default function ApiDashboardHomeSummary() {
  return null;
}
