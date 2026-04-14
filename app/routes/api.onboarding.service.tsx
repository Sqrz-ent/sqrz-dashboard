import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

export async function action({ request }: { request: Request }) {
  const { supabase } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return Response.json({ error: "Profile not found" }, { status: 404 });
  }

  const body = await request.json();
  const { title, description, booking_type, instant_price, instant_currency } = body;

  if (!title?.trim()) {
    return Response.json({ error: "Title is required" }, { status: 400 });
  }

  const adminClient = createSupabaseAdminClient();
  const { error } = await adminClient.from("profile_services").insert({
    profile_id: profile.id,
    title: title.trim(),
    description: description?.trim() || null,
    booking_type: booking_type === "instant" ? "instant" : "quote",
    instant_price: booking_type === "instant" ? (parseFloat(instant_price) || null) : null,
    instant_currency: booking_type === "instant" ? (instant_currency || "EUR") : null,
    is_active: true,
    sort_order: 0,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
