import type { SupabaseClient } from "@supabase/supabase-js";

import type { MessagingProvider } from "~/lib/messaging/types";
import { toStreamMainChannelId } from "~/lib/messaging/stream.server";

function toSupabaseMainChannelId(bookingId: string) {
  return `booking_${bookingId}_main`;
}

export async function persistMessagingProviderForBooking(input: {
  admin: SupabaseClient;
  bookingId: string;
  provider: MessagingProvider;
}) {
  const { admin, bookingId, provider } = input;
  const providerChannelId =
    provider === "stream" ? toStreamMainChannelId(bookingId) : toSupabaseMainChannelId(bookingId);

  const { data: existing } = await admin
    .from("booking_channels")
    .select("id, provider")
    .eq("booking_id", bookingId)
    .eq("type", "main")
    .is("role_key", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    return;
  }

  const { error } = await admin
    .from("booking_channels")
    .insert({
      booking_id: bookingId,
      provider,
      provider_channel_id: providerChannelId,
      type: "main",
      role_key: null,
    });

  if (error) {
    throw error;
  }
}

export async function resolveMessagingProviderForBooking(input: {
  admin: SupabaseClient;
  bookingId: string;
}): Promise<MessagingProvider> {
  const { admin, bookingId } = input;

  const { data: existingChannel } = await admin
    .from("booking_channels")
    .select("provider")
    .eq("booking_id", bookingId)
    .eq("type", "main")
    .is("role_key", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existingChannel?.provider === "stream" || existingChannel?.provider === "supabase") {
    return existingChannel.provider as MessagingProvider;
  }

  const { data: booking } = await admin
    .from("bookings")
    .select("owner_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking?.owner_id) return "supabase";

  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("plan_id")
    .eq("id", booking.owner_id as string)
    .maybeSingle();

  const provider =
    ownerProfile?.plan_id != null && Number(ownerProfile.plan_id) > 0 ? "stream" : "supabase";

  await persistMessagingProviderForBooking({
    admin,
    bookingId,
    provider,
  });

  return provider;
}
