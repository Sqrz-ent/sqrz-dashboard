import { StreamChat } from "stream-chat";

import { createSupabaseAdminClient } from "~/lib/supabase.server";
import {
  createStreamUserToken,
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

const LEAD_PREVIEW_MAX = 280;

// A short text snapshot of a chat thread for the lead card — the FIRST non-empty
// message (the "why they reached out", more representative than a trailing
// "ok thanks"), capped. Static preview, not a live sync. Returns null on any
// failure / empty thread so the lead upsert never breaks on this.
export async function fetchInquiryMessagePreview(providerChannelId: string): Promise<string | null> {
  try {
    const channel = await queryStreamChannel(providerChannelId);
    const messages = (channel?.state?.messages ?? []) as Array<{ text?: string }>;
    const first = messages
      .map((m) => (typeof m.text === "string" ? m.text.trim() : ""))
      .find((t) => t.length > 0);
    if (!first) return null;
    return first.length > LEAD_PREVIEW_MAX ? `${first.slice(0, LEAD_PREVIEW_MAX - 1)}…` : first;
  } catch {
    return null;
  }
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
      .select("id, slug, name, brand_name, first_name, last_name")
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

  if (!profile?.id || !threads?.length) {
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

