import type { Route } from "./+types/api.location-search";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { proDeniedResponse } from "~/lib/pro.server";
import { isWebCampaignCreateEnabled } from "~/lib/flags.server";

// City search for campaign geo-targeting on the web (iOS uses MapKit's on-device
// completer, which has no web equivalent). Server-side proxy to OpenStreetMap
// Nominatim — settlements only; returns the same shape the create form stores:
// a city name plus coordinates (the radius is chosen separately). Cookie-auth +
// Pro only; callers debounce (Nominatim allows ~1 request/second).
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const denied = await proDeniedResponse(supabase, user.id, headers);
  if (denied) return denied;
  // Only used by the web create-campaign form — off with it (app_config.web_campaign_create_enabled).
  if (!(await isWebCampaignCreateEnabled(supabase))) return Response.json({ results: [] }, { status: 403, headers });

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ results: [] }, { headers });

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&featuretype=settlement&q=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": "SQRZ-dashboard/1.0 (info@sqrz.com)", "Accept-Language": "en" } }
    );
    if (!res.ok) return Response.json({ results: [], error: "search_failed" }, { headers });
    const items = (await res.json()) as Array<{ lat: string; lon: string; name?: string; display_name: string; address?: Record<string, string> }>;
    const seen = new Set<string>();
    const results = items
      .map((i) => {
        const a = i.address ?? {};
        const name = a.city || a.town || a.village || a.municipality || a.county || i.name || i.display_name.split(",")[0];
        return { name, display: i.display_name, latitude: Number(i.lat), longitude: Number(i.lon) };
      })
      .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
      .filter((r) => (seen.has(r.display) ? false : (seen.add(r.display), true)));
    return Response.json({ results }, { headers });
  } catch {
    return Response.json({ results: [], error: "search_failed" }, { headers });
  }
}
