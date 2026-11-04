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

// The sender for the two automated intro messages below — a real Stream
// user id is required for a server-side sendMessage call (there's no
// "connected user" context server-side), but this user is never added as a
// channel member: it's not a participant, just the sender of record for
// system-authored text.
const SQRZ_SYSTEM_USER_ID = "sqrz_system";

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

// state: true — ensureSupportThread needs to inspect .state.messages to
// tell a genuinely-answered thread apart from one left empty by a failed
// earlier attempt (see its own doc comment).
async function queryStreamChannelById(channelId: string) {
  const client = getStreamServerClient();
  const channels = await client.queryChannels(
    { type: STREAM_CHANNEL_TYPE, id: channelId },
    [],
    { watch: false, state: true },
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

// Resolves a Lab account's display name (its oldest/main profile) and
// upserts its team_<accountId> Stream user — the same shape
// ensureTeamStreamIdentity already upserts for the calling account. Shared
// so ensureSupportThread can do the same thing for EVERY Lab account, not
// just whichever one happens to call support-token.
async function upsertTeamStreamUser(accountId: string): Promise<string> {
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
  return streamUserId;
}

// Every Lab account's team user is a member of `channel` — the inverse of
// ensureTeamStreamIdentity's own backfill (which adds the CALLING account to
// every existing support channel): this adds every Lab account to THIS one
// channel, whether just created or already existing, so a thread is visible
// to the whole team immediately rather than only to whoever next calls
// support-token.
async function ensureLabTeamMembership(channel: any): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { data: labAccounts } = await admin.from("accounts").select("id").eq("is_lab", true);
  if (!labAccounts?.length) return;

  const streamUserIds = await Promise.all(
    labAccounts.map((a) => upsertTeamStreamUser(a.id as string)),
  );

  const members = new Set(Object.keys(channel.state?.members ?? {}));
  const missing = streamUserIds.filter((id) => !members.has(id));
  if (missing.length) {
    await channel.addMembers(missing);
  }
}

// Upserts the system sender, then posts the request-summary message and the
// "thanks, we'll reply" message, both authored by it. `channel` is whatever
// client.channel(...)/queryChannels returned — both are the same Channel
// class under the hood, so either is a valid sendMessage target; left as
// `any` like the rest of this file's Stream SDK interop.
async function postIntroMessages(
  channel: any,
  row: ManagedRequestRow,
  templateName: string | null,
): Promise<void> {
  const client = getStreamServerClient();
  await client.upsertUsers([{ id: SQRZ_SYSTEM_USER_ID, name: "SQRZ", role: "admin" } as any]);

  await channel.sendMessage({
    text: summarizeRequest(row, templateName),
    type: "system",
    user_id: SQRZ_SYSTEM_USER_ID,
  } as Record<string, unknown>);
  await channel.sendMessage({
    text: "Thanks! A real person from the SQRZ team replies within 24 hours, usually under 12.",
    type: "system",
    user_id: SQRZ_SYSTEM_USER_ID,
  } as Record<string, unknown>);
}

// The channel's display name ("<profile display name> · <template name>")
// and image (the profile's avatar_url). Display name = brand_name, else
// name, else first + last name.
async function resolveChannelDisplay(row: ManagedRequestRow, templateName: string | null): Promise<{
  name: string;
  image: string | null;
}> {
  const admin = createSupabaseAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("name, brand_name, first_name, last_name, avatar_url")
    .eq("id", row.profile_id)
    .maybeSingle();

  const displayName =
    (profile?.brand_name as string | null) ||
    (profile?.name as string | null) ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
    null;

  const name = [displayName, templateName ?? row.campaign_template ?? "Untitled template"]
    .filter(Boolean)
    .join(" · ");
  const image = (profile?.avatar_url as string | null) ?? null;
  return { name, image };
}

/**
 * Creates the support channel for `row` if it doesn't exist yet, or returns
 * the existing one. The caller (api.messaging.support-thread.ts) upserts the
 * customer's own Stream user BEFORE calling this — channel.create() below
 * sets created_by_id/members to that id, which Stream rejects if the user
 * doesn't exist yet.
 *
 * The two intro messages (request summary + "thanks, we'll reply") are
 * posted on first creation, authored by the sqrz_system Stream user (see
 * postIntroMessages) — never the customer. They're ALSO posted for an
 * existing channel that has zero messages — a leftover from a failed
 * earlier attempt (e.g. the channel got created but a later step threw) —
 * so that thread isn't left silently empty forever. A channel that already
 * has messages is returned unchanged.
 *
 * The channel's name/image (see resolveChannelDisplay) are set at creation,
 * and backfilled onto an existing channel that doesn't have a name yet
 * (e.g. one created before this existed) — never overwritten otherwise.
 *
 * Either way — just created, or an existing one returned — every Lab
 * account's team user is added as a member (ensureLabTeamMembership), so
 * the whole team can see and answer the thread immediately.
 */
export async function ensureSupportThread(row: ManagedRequestRow): Promise<{ channelId: string }> {
  const channelId = toSupportChannelId(row.id);
  const customerStreamUserId = toStreamUserIdForProfile(row.profile_id);

  const existing = await queryStreamChannelById(channelId);

  const admin = createSupabaseAdminClient();
  const { data: template } = row.campaign_template
    ? await admin.from("campaign_templates").select("name").eq("id", row.campaign_template).maybeSingle()
    : { data: null };
  const templateName = (template as { name: string } | null)?.name ?? null;

  let channel = existing;
  let needsIntroMessages: boolean;

  if (channel) {
    needsIntroMessages = ((channel.state?.messages ?? []) as unknown[]).length === 0;
    if (!(channel.data as any)?.name) {
      const { name, image } = await resolveChannelDisplay(row, templateName);
      await channel.update({ name, image } as Record<string, unknown>);
    }
  } else {
    const { name, image } = await resolveChannelDisplay(row, templateName);
    const client = getStreamServerClient();
    channel = client.channel(STREAM_CHANNEL_TYPE, channelId, {
      created_by_id: customerStreamUserId,
      members: [customerStreamUserId],
      kind: SUPPORT_CHANNEL_KIND,
      campaign_id: row.id,
      profile_id: row.profile_id,
      template_id: row.campaign_template,
      name,
      image,
    } as Record<string, unknown>);
    await channel.create();
    needsIntroMessages = true;
  }

  if (needsIntroMessages) {
    await postIntroMessages(channel, row, templateName);
  }

  await ensureLabTeamMembership(channel);

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
