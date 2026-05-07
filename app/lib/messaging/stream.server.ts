import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { StreamChat } from "stream-chat";

import type {
  BookingChannelRecord,
  BookingChannelRoleKey,
  MessagingMember,
} from "~/lib/messaging/types";

type StreamUserPayload = {
  id: string;
  name: string;
  role?: string;
  sqrz_profile_id?: string;
  sqrz_participant_id?: string;
};

const STREAM_CHANNEL_TYPE = "messaging";

function getStreamEnv() {
  const apiKey = process.env.STREAM_API_KEY;
  const apiSecret = process.env.STREAM_API_SECRET;

  if (!apiKey) throw new Error("STREAM_API_KEY is not set");
  if (!apiSecret) throw new Error("STREAM_API_SECRET is not set");

  return { apiKey, apiSecret };
}

export function isStreamConfigured() {
  return !!process.env.STREAM_API_KEY && !!process.env.STREAM_API_SECRET;
}

function toBase64Url(input: Buffer | string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signJwt(payload: Record<string, unknown>, secret: string) {
  const header = { typ: "JWT", alg: "HS256" };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(unsignedToken).digest();
  return `${unsignedToken}.${toBase64Url(signature)}`;
}

function createStreamServerToken() {
  const { apiSecret } = getStreamEnv();
  const exp = Math.floor(Date.now() / 1000) + (15 * 60);
  return signJwt({ server: true, exp }, apiSecret);
}

export function createStreamUserToken(streamUserId: string) {
  const { apiSecret } = getStreamEnv();
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      user_id: streamUserId,
      iat: now,
      exp: now + (60 * 60),
    },
    apiSecret
  );
}

function createStreamHeaders() {
  const { apiKey } = getStreamEnv();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Stream-Auth-Type": "jwt",
    Authorization: createStreamServerToken(),
    api_key: apiKey,
  };
}

function getStreamServerClient() {
  const { apiKey, apiSecret } = getStreamEnv();
  return StreamChat.getInstance(apiKey, apiSecret);
}

export type BookingChatSummary = {
  bookingId: string;
  unreadCount: number;
  lastReadAt: string | null;
  lastMessageAt: string | null;
};

export function toStreamMainChannelId(bookingId: string) {
  return `booking_${bookingId}_main`;
}

export function toStreamRoleChannelId(bookingId: string, roleKey: BookingChannelRoleKey) {
  const normalizedRoleKey = String(roleKey).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `booking_${bookingId}_${normalizedRoleKey}`;
}

export function toStreamUserIdForProfile(profileId: string) {
  return `profile_${profileId}`;
}

export function toStreamUserIdForParticipant(participantId: string) {
  return `booking_participant_${participantId}`;
}

export async function resolveStreamIdentityForParticipant(input: {
  admin: SupabaseClient;
  participantId: string;
  linkedUserId?: string | null;
}) {
  const { admin, participantId, linkedUserId } = input;

  if (!linkedUserId) {
    return {
      profileId: null,
      streamUserId: toStreamUserIdForParticipant(participantId),
    };
  }

  const { data: linkedProfile } = await admin
    .from("profiles")
    .select("id")
    .eq("user_id", linkedUserId)
    .maybeSingle();

  if (!linkedProfile?.id) {
    return {
      profileId: null,
      streamUserId: toStreamUserIdForParticipant(participantId),
    };
  }

  return {
    profileId: linkedProfile.id as string,
    streamUserId: toStreamUserIdForProfile(linkedProfile.id as string),
  };
}

export async function listBookingMessagingMembers(input: {
  admin: SupabaseClient;
  bookingId: string;
}): Promise<MessagingMember[]> {
  const { admin, bookingId } = input;

  const [{ data: booking }, { data: participants }] = await Promise.all([
    admin
      .from("bookings")
      .select("id, owner_id, title")
      .eq("id", bookingId)
      .maybeSingle(),
    admin
      .from("booking_participants")
      .select("id, user_id, email, name, role")
      .eq("booking_id", bookingId),
  ]);

  if (!booking?.owner_id) {
    throw new Error(`Booking ${bookingId} not found`);
  }

  const ownerProfileId = booking.owner_id as string;
  const participantRows = (participants ?? []) as Array<Record<string, unknown>>;
  const participantUserIds = participantRows
    .map((row) => row.user_id as string | null)
    .filter((value): value is string => !!value);

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, user_id, email, name, brand_name, first_name, last_name")
    .in("id", [ownerProfileId]);

  const { data: linkedProfiles } = participantUserIds.length > 0
    ? await admin
        .from("profiles")
        .select("id, user_id, email, name, brand_name, first_name, last_name")
        .in("user_id", participantUserIds)
    : { data: [] as Array<Record<string, unknown>> };

  const profilesById = new Map(
    (profiles ?? []).map((profile) => [profile.id as string, profile as Record<string, unknown>])
  );
  const profilesByUserId = new Map(
    (linkedProfiles ?? []).map((profile) => [profile.user_id as string, profile as Record<string, unknown>])
  );

  const ownerProfile = profilesById.get(ownerProfileId);
  if (!ownerProfile) {
    throw new Error(`Owner profile ${ownerProfileId} not found for booking ${bookingId}`);
  }

  const members = new Map<string, MessagingMember>();

  const ownerName =
    (ownerProfile.brand_name as string | null) ||
    (ownerProfile.name as string | null) ||
    [ownerProfile.first_name, ownerProfile.last_name].filter(Boolean).join(" ") ||
    ((ownerProfile.email as string | null)?.split("@")[0] ?? "Booking Owner");

  members.set(toStreamUserIdForProfile(ownerProfileId), {
    streamUserId: toStreamUserIdForProfile(ownerProfileId),
    displayName: ownerName,
    email: (ownerProfile.email as string | null) ?? null,
    profileId: ownerProfileId,
    participantId: null,
    roleKey: "admin",
    isOwner: true,
  });

  for (const participant of participantRows) {
    const linkedProfile = participant.user_id
      ? profilesByUserId.get(participant.user_id as string)
      : null;

    const profileId = (linkedProfile?.id as string | undefined) ?? null;
    const participantId = participant.id as string;
    const streamUserId = profileId
      ? toStreamUserIdForProfile(profileId)
      : toStreamUserIdForParticipant(participantId);
    const participantName =
      (linkedProfile?.brand_name as string | null) ||
      (linkedProfile?.name as string | null) ||
      [linkedProfile?.first_name, linkedProfile?.last_name].filter(Boolean).join(" ") ||
      (participant.name as string | null) ||
      ((participant.email as string | null)?.split("@")[0] ?? "Guest");

    members.set(streamUserId, {
      streamUserId,
      displayName: participantName,
      email: (linkedProfile?.email as string | null) ?? (participant.email as string | null) ?? null,
      profileId,
      participantId,
      roleKey: (participant.role as string | null) ?? "worker",
      isOwner: false,
    });
  }

  return [...members.values()];
}

async function upsertStreamUsers(users: StreamUserPayload[]) {
  if (users.length === 0) return;

  const client = getStreamServerClient();
  await client.upsertUsers(users);
}

async function queryStreamChannel(channelId: string) {
  const client = getStreamServerClient();
  const channels = await client.queryChannels(
    {
      type: STREAM_CHANNEL_TYPE,
      id: channelId,
    },
    [],
    {
      watch: false,
      state: true,
    }
  );

  return channels[0] ?? null;
}

async function createStreamChannel(input: {
  channelId: string;
  createdById: string;
  bookingId: string;
  memberIds: string[];
}) {
  const { channelId, createdById, bookingId, memberIds } = input;
  const client = getStreamServerClient();
  const channel = client.channel(STREAM_CHANNEL_TYPE, channelId, {
    created_by_id: createdById,
    members: memberIds,
    sqrz_booking_id: bookingId,
    sqrz_channel_type: "main",
  } as any);

  await channel.create();
}

async function syncStreamChannelMembers(input: {
  channelId: string;
  desiredMemberIds: string[];
}) {
  const { channelId, desiredMemberIds } = input;
  const channel = await queryStreamChannel(channelId);

  if (!channel) return;

  const currentMemberIds = new Set(
    Object.keys(channel.state.members ?? {}).filter((value): value is string => !!value)
  );
  const desiredSet = new Set(desiredMemberIds);
  const addMembers = desiredMemberIds.filter((memberId) => !currentMemberIds.has(memberId));
  const removeMembers = [...currentMemberIds].filter((memberId) => !desiredSet.has(memberId));

  if (addMembers.length === 0 && removeMembers.length === 0) return;

  if (addMembers.length > 0) {
    await channel.addMembers(addMembers);
  }

  if (removeMembers.length > 0) {
    await channel.removeMembers(removeMembers);
  }
}

async function upsertBookingChannelRecord(input: {
  admin: SupabaseClient;
  bookingId: string;
  providerChannelId: string;
}) {
  const { admin, bookingId, providerChannelId } = input;

  const { data: existing } = await admin
    .from("booking_channels")
    .select("id")
    .eq("booking_id", bookingId)
    .eq("provider", "stream")
    .eq("type", "main")
    .is("role_key", null)
    .maybeSingle();

  if (existing?.id) return existing.id;

  const { error } = await admin
    .from("booking_channels")
    .insert({
      booking_id: bookingId,
      provider: "stream",
      provider_channel_id: providerChannelId,
      type: "main",
      role_key: null,
    });

  if (error) throw error;
}

export async function ensureBookingMainChannel(input: {
  admin: SupabaseClient;
  bookingId: string;
}): Promise<BookingChannelRecord> {
  const { admin, bookingId } = input;
  const members = await listBookingMessagingMembers({ admin, bookingId });
  const channelId = toStreamMainChannelId(bookingId);
  const channel = await queryStreamChannel(channelId);

  await upsertStreamUsers(
    members.map((member) => ({
      id: member.streamUserId,
      name: member.displayName,
      role: member.isOwner ? "admin" : "user",
      sqrz_profile_id: member.profileId ?? undefined,
      sqrz_participant_id: member.participantId ?? undefined,
    }))
  );

  if (!channel) {
    await createStreamChannel({
      channelId,
      createdById: members[0]?.streamUserId ?? channelId,
      bookingId,
      memberIds: members.map((member) => member.streamUserId),
    });
  } else {
    await syncStreamChannelMembers({
      channelId,
      desiredMemberIds: members.map((member) => member.streamUserId),
    });
  }

  await upsertBookingChannelRecord({
    admin,
    bookingId,
    providerChannelId: channelId,
  });

  return {
    id: channelId,
    booking_id: bookingId,
    provider: "stream",
    provider_channel_id: channelId,
    type: "main",
    role_key: null,
  };
}

export async function listBookingChatSummariesForStreamUser(input: {
  streamUserId: string;
  bookingIds: string[];
}): Promise<Record<string, BookingChatSummary>> {
  const { streamUserId, bookingIds } = input;
  if (!bookingIds.length) return {};

  const client = getStreamServerClient();
  const channels = await client.queryChannels(
    {
      type: STREAM_CHANNEL_TYPE,
      members: { $in: [streamUserId] },
      sqrz_booking_id: { $in: bookingIds },
    } as any,
    [{ last_message_at: -1 }] as any,
    {
      watch: false,
      state: true,
    }
  );

  const summaries: Record<string, BookingChatSummary> = {};

  for (const channel of channels) {
    const bookingId =
      (channel.data?.sqrz_booking_id as string | undefined) ??
      (typeof channel.id === "string"
        ? channel.id.match(/^booking_(.+)_main$/)?.[1] ?? null
        : null);

    if (!bookingId) continue;

    const readState = (channel.state.read as Record<string, any> | undefined)?.[streamUserId] ?? null;
    const unreadCount = Number(readState?.unread_messages ?? 0);
    const lastReadAt = typeof readState?.last_read === "string"
      ? readState.last_read
      : readState?.last_read?.toISOString?.() ?? null;
    const lastMessageAt = typeof channel.data?.last_message_at === "string"
      ? (channel.data.last_message_at as string)
      : (channel.state.messages?.at?.(-1)?.created_at as string | undefined) ?? null;

    summaries[bookingId] = {
      bookingId,
      unreadCount,
      lastReadAt,
      lastMessageAt,
    };
  }

  return summaries;
}
