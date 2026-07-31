import { redirect } from "react-router";
import type { Route } from "./+types/_app.links";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { normalizeImageUrl } from "~/lib/image-url";
import { normalizeExternalUrl } from "~/lib/links.server";

// Links now render as an embedded tab inside Grow (/analytics?tab=links,
// see _app.analytics.tsx + LinksSection) rather than this standalone page —
// that page used to render its own top submenu, which is what this moved to
// avoid. This route stays alive as: (1) a redirect for anything that still
// links here directly (bookmarks, etc.), and (2) the action target that
// LinksSection's fetchers submit to, regardless of where the component is
// mounted — same pattern as /boost backing the embedded Campaigns tab.

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  return redirect("/analytics?tab=links", { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const admin = createSupabaseAdminClient();
  const fd = await request.formData();
  const intent = fd.get("intent") as string;

  if (intent === "create") {
    const titleVal = (fd.get("title") as string) || null;
    const externalUrlRaw = (fd.get("external_url") as string) || null;
    const prefillServiceVal = (fd.get("prefill_service") as string) || null;
    const { error } = await admin.from("private_booking_links").insert({
      profile_id: profile.id as string,
      link_slug: fd.get("link_slug") as string,
      is_active: true,
      page_type: "internal",
      title: titleVal,
      label: titleVal,
      show_on_profile: fd.get("show_on_profile") === "true",
      description: (fd.get("description") as string) || null,
      cover_image_url: normalizeImageUrl(fd.get("cover_image_url") as string),
      video_url: (fd.get("video_url") as string) || null,
      external_url: externalUrlRaw ? normalizeExternalUrl(externalUrlRaw) : null,
      external_url_label: null,
      prefill_service: prefillServiceVal || null,
      cta_label: (fd.get("cta_label") as string) || null,
      expires_at: null,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "toggle_active") {
    const id = fd.get("id") as string;
    const isActive = fd.get("is_active") === "true";
    const { error } = await admin
      .from("private_booking_links")
      .update({ is_active: !isActive })
      .eq("id", id)
      .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "toggle_show_on_profile") {
    const id = fd.get("id") as string;
    const current = fd.get("show_on_profile") === "true";
    const { error } = await admin
      .from("private_booking_links")
      .update({ show_on_profile: !current })
      .eq("id", id)
      .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update") {
    const id = fd.get("id") as string;
    const titleVal = (fd.get("title") as string) || null;
    const externalUrlRaw = (fd.get("external_url") as string) || null;
    const prefillServiceVal = (fd.get("prefill_service") as string) || null;
    const { error } = await admin.from("private_booking_links").update({
      link_slug: fd.get("link_slug") as string,
      page_type: "internal",
      title: titleVal,
      label: titleVal,
      show_on_profile: fd.get("show_on_profile") === "true",
      description: (fd.get("description") as string) || null,
      cover_image_url: normalizeImageUrl(fd.get("cover_image_url") as string),
      video_url: (fd.get("video_url") as string) || null,
      external_url: externalUrlRaw ? normalizeExternalUrl(externalUrlRaw) : null,
      external_url_label: null,
      prefill_service: prefillServiceVal || null,
      cta_label: (fd.get("cta_label") as string) || null,
      expires_at: null,
    })
    .eq("id", id)
    .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete") {
    const id = fd.get("id") as string;
    const { error } = await admin
      .from("private_booking_links")
      .delete()
      .eq("id", id)
      .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}
