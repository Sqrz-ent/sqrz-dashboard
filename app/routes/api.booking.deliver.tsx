import type { Route } from "./+types/api.booking.deliver";
import {
  createSupabaseAdminClient,
  createSupabaseBearerClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// iOS-only route: the native app marks a booking delivered with a Bearer access token.
// No cookie path — browsers use the booking detail action instead.
export function loader() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Bearer auth only (sqrz-ios). Mirrors the pattern in api.stripe.connect.tsx.
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createSupabaseBearerClient(bearerToken);
  const {
    data: { user },
  } = await supabase.auth.getUser(bearerToken);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { booking_id?: string };
  try {
    body = (await request.json()) as { booking_id?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bookingId = body.booking_id;
  if (!bookingId) return Response.json({ error: "Missing booking_id" }, { status: 400 });

  const admin = createSupabaseAdminClient();

  // Validate the booking exists and is owned by the authenticated user.
  const { data: booking } = await admin
    .from("bookings")
    .select("id, owner_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return Response.json({ error: "Booking not found" }, { status: 404 });
  if (booking.owner_id !== profile.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await admin
    .from("bookings")
    .update({ status: "completed" })
    .eq("id", bookingId)
    .eq("owner_id", profile.id as string);

  return Response.json({ ok: true });
}
