import { StreamChat } from "stream-chat";

import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { createStreamUserToken, toStreamUserIdForProfile } from "~/lib/messaging/stream.server";

// Support chat (V1, Sandbox) — customers (artists who submitted a
// contact-template / managed campaign request, boost_campaigns.is_managed =
// true) chat with the SQRZ team about that specific request. One Stream
// channel per request row: type "messaging", id `support_<campaign_id>`. Any
// Lab account (accounts.is_lab) can read and answer under their own name —
// see api.messaging.support-token.ts for how a team member's own Stream
// identity is minted and added to every support channel.
//
// Deliberately separate from inquiry.server.ts (visitor <-> artist chat),
// even though both sit on the same Stream project and both reuse
// toStreamUserIdForProfile for the "customer" side — support chat is artist
// <-> SQRZ team, a different relationship with its own channel kind
// ("support", via the custom `kind` channel field) and its own team-side
// identity (`team_<account_id>`).

const STREAM_CHANNEL_TYPE = "messaging";
const SUPPORT_CHANNEL_KIND = "support";

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

export function toSupportChannelId(campaignId: string) {
  return `support_${campaignId}`;
}

export function toStreamUserIdForTeamAccount(accountId: string) {
  return `team_${accountId}`;
}

export type ManagedRequestRow = {
  id: string;
  profile_id: string;
  is_managed: boolean;
  name: string | null;
  notes: string | null;
  budget_amount: number | null;
  budget_currency: string | null;
  target_audience: string | null;
  location_city: string | null;
  location_radius_km: number | null;
  campaign_template: string | null;
};

async function queryStreamChannelById(channelId: string) {
  const client = getStreamServerClient();
  const channels = await client.queryChannels(
    { type: STREAM_CHANNEL_TYPE, id: channelId },
    [],
    { watch: false, state: false },
  );
  return channels[0] ?? null;
}

// The "system message summarizing the request" — template name plus whatever
// intake answers are actually present on the row (every field is optional;
// different templates leave different ones null).
function summarizeRequest(row: ManagedRequestRow, templateName: string | null): string {
  const lines = [`New request: ${templateName ?? row.campaign_template ?? "Untitled template"}`];
  if (row.name) lines.push(`Campaign name: ${row.name}`);
  if (row.budget_amount != null) {
    lines.push(`Budget: ${row.budget_amount} ${row.budget_currency ?? ""}`.trim());
  }
  if (row.target_audience) lines.push(`Target audience: ${row.target_audience}`);
  if (row.location_city) {
    lines.push(
      `Location: ${row.location_city}${row.location_radius_km != null ? ` (${row.location_radius_km} km radius)` : ""}`,
    );
  }
  if (row.notes) lines.push(`Goals: ${row.notes}`);
  return lines.join("\n");
}

/**
 * Creates the support channel for `row` if it doesn't exist yet — posting the
 * request-summary system message and the "thanks, we'll reply" system
 * message once, on first creation only — or returns the existing channel's
 * id unchanged on every later call.
 */
export async function ensureSupportThread(row: ManagedRequestRow): Promise<{ channelId: string }> {
  const channelId = toSupportChannelId(row.id);
  const existing = await queryStreamChannelById(channelId);
  if (existing) return { channelId };

  const admin = createSupabaseAdminClient();
  const { data: template } = row.campaign_template
    ? await admin.from("campaign_templates").select("name").eq("id", row.campaign_template).maybeSingle()
    : { data: null };

  const client = getStreamServerClient();
  const customerStreamUserId = toStreamUserIdForProfile(row.profile_id);

  const channel = client.channel(STREAM_CHANNEL_TYPE, channelId, {
    created_by_id: customerStreamUserId,
    members: [customerStreamUserId],
    kind: SUPPORT_CHANNEL_KIND,
    campaign_id: row.id,
    profile_id: row.profile_id,
    template_id: row.campaign_template,
  } as Record<string, unknown>);
  await channel.create();

  await channel.sendMessage({
    text: summarizeRequest(row, (template as { name: string } | null)?.name ?? null),
    type: "system",
  } as Record<string, unknown>);
  await channel.sendMessage({
    text: "Thanks! A real person from the SQRZ team replies within 24 hours, usually under 12.",
    type: "system",
  } as Record<string, unknown>);

  return { channelId };
}

/**
 * Upserts the customer's own Stream identity (toStreamUserIdForProfile) if it
 * doesn't exist yet, and returns a 1-hour Stream token for it — same format
 * as createStreamUserToken. Used by api.messaging.support-thread.ts so the
 * customer can actually connect to the thread it just created/returned.
 */
export async function ensureCustomerStreamIdentity(profileId: string): Promise<{
  streamUserId: string;
  token: string;
}> {
  const streamUserId = toStreamUserIdForProfile(profileId);
  const client = getStreamServerClient();
  await client.upsertUsers([{ id: streamUserId, role: "user" } as any]);
  return { streamUserId, token: createStreamUserToken(streamUserId) };
}

/**
 * Upserts the team's own Stream identity for `accountId` — name = that
 * account's oldest ("main") profile's display name — and adds it as a member
 * of every existing support channel, so a team member who gets Lab access
 * later still sees older threads. Returns a 1-hour Stream token for that
 * identity, same format as createStreamUserToken.
 */
export async function ensureTeamStreamIdentity(accountId: string): Promise<{
  streamUserId: string;
  token: string;
}> {
  const admin = createSupabaseAdminClient();
  const { data: mainProfile } = await admin
    .from("profiles")
    .select("name, brand_name, first_name, last_name, slug")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const teamName =
    (mainProfile?.brand_name as string | null) ||
    (mainProfile?.name as string | null) ||
    [mainProfile?.first_name, mainProfile?.last_name].filter(Boolean).join(" ").trim() ||
    (mainProfile?.slug as string | null) ||
    "SQRZ Team";

  const streamUserId = toStreamUserIdForTeamAccount(accountId);
  const client = getStreamServerClient();
  await client.upsertUsers([
    { id: streamUserId, name: teamName, role: "admin", team: true } as any,
  ]);

  const supportChannels = await client.queryChannels(
    { type: STREAM_CHANNEL_TYPE, kind: SUPPORT_CHANNEL_KIND } as any,
    [],
    { watch: false, state: true },
  );
  await Promise.all(
    supportChannels.map(async (channel) => {
      const members = new Set(Object.keys(channel.state.members ?? {}));
      if (!members.has(streamUserId)) {
        await channel.addMembers([streamUserId]);
      }
    }),
  );

  return { streamUserId, token: createStreamUserToken(streamUserId) };
}
