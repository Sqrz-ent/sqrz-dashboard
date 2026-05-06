import type { SupabaseClient } from "@supabase/supabase-js";

import type { MessagingProvider } from "~/lib/messaging/types";

export async function resolveMessagingProviderForBooking(input: {
  admin: SupabaseClient;
  bookingId: string;
}): Promise<MessagingProvider> {
  const { admin, bookingId } = input;

  const { data: booking } = await admin
    .from("bookings")
    .select("owner_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking?.owner_id) return "supabase";

  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("is_beta")
    .eq("id", booking.owner_id as string)
    .maybeSingle();

  return ownerProfile?.is_beta ? "stream" : "supabase";
}
