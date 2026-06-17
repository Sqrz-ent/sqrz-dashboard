import type { Route } from "./+types/api.booking.deliver";
import {
  createSupabaseAdminClient,
  createSupabaseBearerClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { handleBookingReferral } from "~/lib/booking-referral.server";

type ProposalStripeMode = "live" | "test";

// iOS-only route: the native app marks a booking delivered with a Bearer access token.
// Mirrors the `mark_as_delivered` intent in booking.$id.tsx (booking → completed, wallet
// payout approved + delivery/auto-release timestamps, referral commission). No cookie
// path — browsers use the booking detail action instead.
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

  let body: { booking_id?: string; wallet_id?: string };
  try {
    body = (await request.json()) as { booking_id?: string; wallet_id?: string };
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

  // ── Mirror of the mark_as_delivered intent ───────────────────────────────────
  await admin
    .from("bookings")
    .update({ status: "completed" })
    .eq("id", bookingId)
    .eq("owner_id", profile.id as string);

  await admin
    .from("booking_wallets")
    .update({
      payout_status: "approved",
      delivery_confirmed_at: new Date().toISOString(),
      auto_release_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    })
    .eq("booking_id", bookingId);

  try {
    const { data: wallet } = await admin
      .from("booking_wallets")
      .select("secured_amount, stripe_mode")
      .eq("booking_id", bookingId)
      .maybeSingle();
    if (wallet?.secured_amount) {
      await handleBookingReferral({
        supabase: admin,
        bookingId,
        bookingValue: Number(wallet.secured_amount),
        stripeMode: (wallet.stripe_mode as ProposalStripeMode | null) ?? "live",
      });
    }
  } catch (err) {
    console.error("[api/booking/deliver] referral commission failed:", err);
  }

  return Response.json({ ok: true });
}
