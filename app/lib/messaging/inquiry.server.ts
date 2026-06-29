import { StreamChat } from "stream-chat";

import { createSupabaseAdminClient } from "~/lib/supabase.server";
import {
  createStreamUserToken,
  ensureBookingMainChannel,
  resolveStreamIdentityForParticipant,
  toStreamUserIdForProfile,
} from "~/lib/messaging/stream.server";

const STREAM_CHANNEL_TYPE = "messaging";

type InquiryThreadRow = {
  id: string;
  profile_id: string;
  status: "open" | "converted" | "closed";
  provider_channel_id: string;
  visitor_token: string;
  visitor_stream_user_id: string;
  owner_stream_user_id: string;
  visitor_name: string | null;
  visitor_email: string | null;
  created_at: string;
};

function getStreamEnv() {
  const apiKey = process.env.STREAM_API_KEY;
  const apiSecret = process.env.STREAM_API_SECRET;

  if (!apiKey) throw new Error("STREAM_API_KEY is not set");
  if (!apiSecret) throw new Error("STREAM_API_SECRET is not set");

  return { apiKey, apiSecret };
}

function getStreamServerClient() {
  const { apiKey, apiSecret } = getStreamEnv();
  return StreamChat.getInstance(apiKey, apiSecret);
}

function formatProfileName(profile: Record<string, unknown>) {
  return (
    (profile.brand_name as string | null) ||
    (profile.name as string | null) ||
    ((profile.slug as string | null) ?? "SQRZ Host")
  );
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

async function ensureInquiryChannel(input: {
  thread: InquiryThreadRow;
  ownerName: string;
}) {
  const { thread, ownerName } = input;
  const client = getStreamServerClient();

  await client.upsertUsers([
    {
      id: thread.owner_stream_user_id,
      name: ownerName,
      role: "admin",
      sqrz_profile_id: thread.profile_id,
    } as any,
    {
      id: thread.visitor_stream_user_id,
      name: thread.visitor_name || "Visitor",
      role: "user",
    } as any,
  ]);

  const existingChannel = await queryStreamChannel(thread.provider_channel_id);
  if (!existingChannel) {
    const channel = client.channel(STREAM_CHANNEL_TYPE, thread.provider_channel_id, {
      created_by_id: thread.owner_stream_user_id,
      members: [thread.owner_stream_user_id, thread.visitor_stream_user_id],
      sqrz_inquiry_thread_id: thread.id,
      sqrz_profile_id: thread.profile_id,
      sqrz_thread_kind: "profile_inquiry",
    } as any);
    await channel.create();
    return;
  }

  const existingMembers = new Set(Object.keys(existingChannel.state.members ?? {}));
  const missingMembers = [thread.owner_stream_user_id, thread.visitor_stream_user_id]
    .filter((memberId) => !existingMembers.has(memberId));

  if (missingMembers.length > 0) {
    await existingChannel.addMembers(missingMembers);
  }
}

function toInquirySession(input: {
  thread: InquiryThreadRow;
  ownerStreamUserId: string;
  ownerName: string;
}) {
  const { thread, ownerStreamUserId, ownerName } = input;
  return {
    thread: {
      id: thread.id,
      visitorName: thread.visitor_name,
      visitorEmail: thread.visitor_email,
      channelId: thread.provider_channel_id,
      createdAt: thread.created_at,
    },
    streamUser: {
      id: ownerStreamUserId,
      name: ownerName,
    },
    token: createStreamUserToken(ownerStreamUserId),
  };
}

export async function listOpenInquiryThreadsForProfile(profileId: string) {
  const admin = createSupabaseAdminClient();

  const [{ data: profile }, { data: threads }] = await Promise.all([
    admin
      .from("profiles")
      .select("id, slug, plan_id, name, brand_name, first_name, last_name")
      .eq("id", profileId)
      .maybeSingle(),
    admin
      .from("profile_inquiry_threads")
      .select("*")
      .eq("profile_id", profileId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const hasPremiumAccess = profile?.plan_id != null && Number(profile.plan_id) > 0;

  if (!profile?.id || !hasPremiumAccess || !threads?.length) {
    return null;
  }

  const ownerStreamUserId = toStreamUserIdForProfile(profileId);
  const ownerName = formatProfileName(profile as Record<string, unknown>);
  const resolvedThreads = (threads as InquiryThreadRow[]).map((thread) => ({
    ...thread,
    owner_stream_user_id: ownerStreamUserId,
  }));

  // Channel sync is best-effort: the inquiry channel was already created at
  // inquiry-start time, so re-ensuring it is belt-and-suspenders. A Stream API
  // failure here must NOT block the token response — the client only needs the
  // token to connect, and Stream will surface any real channel issue on watch.
  await Promise.all(
    resolvedThreads.map(async (thread) => {
      try {
        await ensureInquiryChannel({ thread, ownerName });
      } catch (error) {
        console.error(
          `[inquiry] ensureInquiryChannel failed for thread ${thread.id} (channel ${thread.provider_channel_id}):`,
          error
        );
      }
    })
  );

  return {
    apiKey: getStreamEnv().apiKey,
    threads: resolvedThreads.map((thread) =>
      toInquirySession({
        thread,
        ownerStreamUserId,
        ownerName,
      }).thread
    ),
    streamUser: {
      id: ownerStreamUserId,
      name: ownerName,
    },
    token: createStreamUserToken(ownerStreamUserId),
  };
}

export async function finalizeInquiryConversion(input: {
  threadId: string;
  bookingId: string;
}) {
  const { threadId, bookingId } = input;
  const admin = createSupabaseAdminClient();

  const { data: thread } = await admin
    .from("profile_inquiry_threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread) {
    throw new Error("Inquiry thread not found");
  }

  const inquiryThread = thread as InquiryThreadRow;
  if (inquiryThread.status === "converted") {
    return;
  }

  const [sourceChannel, bookingChannel, buyerParticipantResponse] = await Promise.all([
    queryStreamChannel(inquiryThread.provider_channel_id),
    ensureBookingMainChannel({ admin, bookingId }),
    admin
      .from("booking_participants")
      .select("id, user_id")
      .eq("booking_id", bookingId)
      .eq("role", "buyer")
      .maybeSingle(),
  ]);

  if (!sourceChannel) {
    throw new Error("Inquiry channel not found");
  }

  const targetChannel = await queryStreamChannel(bookingChannel.provider_channel_id);
  if (!targetChannel) {
    throw new Error("Booking channel not found");
  }

  const buyerParticipant = buyerParticipantResponse.data;

  const buyerIdentity = buyerParticipant?.id
    ? await resolveStreamIdentityForParticipant({
        admin,
        participantId: buyerParticipant.id as string,
        linkedUserId: (buyerParticipant.user_id as string | null) ?? null,
      })
    : null;

  const buyerStreamUserId = buyerIdentity?.streamUserId ?? inquiryThread.visitor_stream_user_id;
  const messages = [...((sourceChannel.state.messages ?? []) as Array<Record<string, unknown>>)]
    .filter((message) => typeof message.text === "string" && String(message.text).trim().length > 0)
    .sort((a, b) => new Date(String(a.created_at ?? 0)).getTime() - new Date(String(b.created_at ?? 0)).getTime());

  for (const message of messages) {
    const sourceUserId = (message.user as { id?: string } | undefined)?.id;
    const asUserId = sourceUserId === inquiryThread.visitor_stream_user_id
      ? buyerStreamUserId
      : inquiryThread.owner_stream_user_id;

    await (targetChannel as any).sendMessage({
      text: String(message.text),
      user_id: asUserId,
    });
  }

  const { error } = await admin
    .from("profile_inquiry_threads")
    .update({
      status: "converted",
      converted_booking_id: bookingId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", threadId);

  if (error) {
    throw new Error(error.message);
  }
}
