import type { SupabaseClient } from "@supabase/supabase-js";

export type PrivateLink = {
  id: string;
  link_slug: string | null;
  is_active: boolean;
  show_on_profile: boolean;
  page_type: string;
  title: string | null;
  use_count: number;
  unique_visitors: number;
  views_7d: number;
  referrer_count: number;
  booking_modal_opens: number;
  booking_requests: number;
  download_clicks: number;
  expires_at: string | null;
  max_uses: number | null;
  description: string | null;
  cover_image_url: string | null;
  external_url: string | null;
  external_url_label: string | null;
  prefill_service: string | null;
  event_date: string | null;
  event_venue: string | null;
  event_city: string | null;
  lead_gate: boolean;
  lead_count: number;
  video_url: string | null;
  cta_label: string | null;
};

export type ProfileService = { id: string; title: string };

export type LinksSectionData = {
  username: string;
  profileId: string;
  links: PrivateLink[];
  services: ProfileService[];
};

// Shared by the /links route (action-only, see _app.links.tsx) and the Grow
// page's embedded Links tab (_app.analytics.tsx) — same data, two mount points.
export async function loadLinksSectionData(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  profile: Record<string, unknown>
): Promise<LinksSectionData> {
  const [linksRes, servicesRes] = await Promise.all([
    supabase
      .from("private_booking_links")
      .select("id, link_slug, is_active, show_on_profile, page_type, title, use_count, expires_at, max_uses, description, cover_image_url, external_url, external_url_label, prefill_service, event_date, event_venue, event_city, lead_gate, video_url, cta_label")
      .eq("profile_id", profile.id as string)
      .order("created_at", { ascending: false }),
    // Use the admin client (not the RLS-scoped `supabase`): the owner reads ALL of
    // their own services here regardless of is_active/is_published. The profile_services
    // RLS owner policy compares auth.uid() to profile_id (= profiles.id), which never
    // matches for migrated users (profiles.id != auth.users.id), and public_read is
    // gated on is_published — so the RLS path returns nothing for unpublished owners.
    admin
      .from("profile_services")
      .select("id, title")
      .eq("profile_id", profile.id as string)
      .order("sort_order", { ascending: true }),
  ]);

  const rawLinks = linksRes.data ?? [];

  // Fetch per-link stats from profile_views + jitsu_events
  const linkIds = rawLinks.map((l) => l.id as string);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const profileSlug = profile.slug as string;

  const uniqueVisitorMap: Record<string, number> = {};
  const views7dMap: Record<string, number> = {};
  const referrerCountMap: Record<string, number> = {};
  const downloadClickMap: Record<string, number> = {};
  const leadCountMap: Record<string, number> = {};
  let bookingModalOpens = 0;
  let bookingRequests = 0;

  if (linkIds.length > 0) {
    const [{ data: viewRows }, { count: modalOpens }, { count: requestsSent }, { data: downloadRows }, { data: leadRows }] = await Promise.all([
      admin
        .from("profile_views")
        .select("link_id, visitor_fingerprint, created_at, referrer")
        .in("link_id", linkIds),
      admin
        .from("jitsu_events")
        .select("*", { count: "exact", head: true })
        .eq("profile_slug", profileSlug)
        .eq("event_type", "booking_modal_open"),
      admin
        .from("jitsu_events")
        .select("*", { count: "exact", head: true })
        .eq("profile_slug", profileSlug)
        .eq("event_type", "booking_request_sent"),
      admin
        .from("jitsu_events")
        .select("event_properties")
        .eq("profile_slug", profileSlug)
        .in("event_type", ["external_link_clicked", "download_clicked"]),
      admin
        .from("link_leads")
        .select("link_id")
        .in("link_id", linkIds),
    ]);

    bookingModalOpens = modalOpens ?? 0;
    bookingRequests = requestsSent ?? 0;

    // External-link clicks per link_slug — consolidated download_clicked (legacy)
    // + external_link_clicked (new). Skip pill clicks that route to the hosted
    // /{slug} page (destination:'page'); those are navigations, not external
    // opens. Legacy download_clicked rows carry no destination and always count.
    for (const row of downloadRows ?? []) {
      const props = row.event_properties as Record<string, string> | null;
      if (props?.destination === "page") continue;
      const ls = props?.link_slug;
      if (ls) downloadClickMap[ls] = (downloadClickMap[ls] ?? 0) + 1;
    }

    // Unique visitors (deduplicated by fingerprint per link)
    const seen: Record<string, Set<string>> = {};
    for (const row of viewRows ?? []) {
      const lid = row.link_id as string;
      const fp = row.visitor_fingerprint as string | null;
      if (fp) {
        if (!seen[lid]) seen[lid] = new Set();
        seen[lid].add(fp);
      }
    }
    for (const lid of Object.keys(seen)) {
      uniqueVisitorMap[lid] = seen[lid].size;
    }

    // Views last 7 days per link
    for (const row of viewRows ?? []) {
      const lid = row.link_id as string;
      if ((row.created_at as string) >= sevenDaysAgo) {
        views7dMap[lid] = (views7dMap[lid] ?? 0) + 1;
      }
    }

    // Referrer count per link
    for (const row of viewRows ?? []) {
      const lid = row.link_id as string;
      if (row.referrer) {
        referrerCountMap[lid] = (referrerCountMap[lid] ?? 0) + 1;
      }
    }

    // Lead count per link
    for (const row of leadRows ?? []) {
      const lid = row.link_id as string;
      leadCountMap[lid] = (leadCountMap[lid] ?? 0) + 1;
    }
  }

  const links = rawLinks.map((l) => ({
    ...l,
    unique_visitors: uniqueVisitorMap[l.id as string] ?? 0,
    views_7d: views7dMap[l.id as string] ?? 0,
    referrer_count: referrerCountMap[l.id as string] ?? 0,
    booking_modal_opens: bookingModalOpens,
    booking_requests: bookingRequests,
    download_clicks: downloadClickMap[l.link_slug as string] ?? 0,
    lead_count: leadCountMap[l.id as string] ?? 0,
  })) as PrivateLink[];

  return {
    username: profile.slug as string,
    profileId: profile.id as string,
    links,
    services: servicesRes.data ?? [],
  };
}

// Ensure an external URL has a protocol so it resolves as an absolute link
// (a bare "spotify.com" would otherwise be treated as a relative path).
export function normalizeExternalUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
