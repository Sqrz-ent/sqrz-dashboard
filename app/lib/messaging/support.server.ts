import { StreamChat } from "stream-chat";

import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { createStreamUserToken, toStreamUserIdForProfile } from "~/lib/messaging/stream.server";

// Support chat (V1, Sandbox) — customers (artists who submitted a
// contact-template / managed campaign request, boost_campaigns.is_managed =
// true) chat with the SQRZ team about their requests. ONE Stream channel PER
// PROFILE (not per request): type "messaging", id `support_<profile_id>`,
// custom data { kind: "support", profile_id }. Any Lab account
// (accounts.is_lab) can read and answer under their own name — see
// api.messaging.support-token.ts for how a team member's own Stream identity
// is minted and added to every support channel.
//
// Each individual request still gets its own one-time summary message in
// that shared channel (see ensureSupportThread) — campaign_id/template_id
// live on that MESSAGE's own custom data now, not on the channel, since one
// channel can span many requests over a profile's lifetime.
//
// Per-request channels (support_<campaign_id>) from before this model
// changed are left exactly as they were in Stream — never migrated/deleted —
// but are excluded from every new code path here, which all key off the new
// id/data shape (see EXCLUDE_LEGACY_CHANNEL_FILTER below).
//
// Deliberately separate from inquiry.server.ts (visitor <-> artist chat),
// even though both sit on the same Stream project and both reuse
// toStreamUserIdForProfile for the "customer" side — support chat is artist
// <-> SQRZ team, a different relationship with its own channel kind
// ("support", via the custom `kind` channel field) and its own team-side
// identity (`team_<account_id>`).

const STREAM_CHANNEL_TYPE = "messaging";
const SUPPORT_CHANNEL_KIND = "support";

// A legacy support_<campaign_id> channel carries a channel-level campaign_id
// (the new support_<profile_id> channels never do — campaign_id now only
// ever lives on an individual MESSAGE's own custom data, see
// ensureSupportThread). Spread into any channel-list filter that should see
// only current, per-profile channels.
const EXCLUDE_LEGACY_CHANNEL_FILTER = { campaign_id: { $exists: false } } as const;

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

export function toSupportChannelId(profileId: string) {
  return `support_${profileId}`;
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
// check whether this particular request's summary has already been posted
// (see its own doc comment).
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

// Repair helper — adds `streamUserId` as a member of `channel` if it isn't
// already one. Used both for the customer (a channel "created client-side
// earlier" might be missing them) and, via ensureLabTeamMembership below,
// every Lab account's team user.
async function ensureMember(channel: any, streamUserId: string): Promise<void> {
  const members = new Set(Object.keys(channel.state?.members ?? {}));
  if (!members.has(streamUserId)) {
    await channel.addMembers([streamUserId]);
  }
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

// The channel's display name (the profile's own display name — no template
// name appended now, since one channel can span many requests over time)
// and image (the profile's avatar_url). Display name = brand_name, else
// name, else first + last name.
async function resolveChannelDisplay(profileId: string): Promise<{
  name: string;
  image: string | null;
}> {
  const admin = createSupabaseAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("name, brand_name, first_name, last_name, avatar_url")
    .eq("id", profileId)
    .maybeSingle();

  const name =
    (profile?.brand_name as string | null) ||
    (profile?.name as string | null) ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
    "";
  const image = (profile?.avatar_url as string | null) ?? null;
  return { name, image };
}

// Posted exactly once, the moment the profile's channel is first created —
// never again after that, regardless of how many requests follow.
async function postWelcomeMessage(channel: any): Promise<void> {
  const client = getStreamServerClient();
  await client.upsertUsers([{ id: SQRZ_SYSTEM_USER_ID, name: "SQRZ", role: "admin" } as any]);
  await channel.sendMessage({
    text: "Thanks! A real person from the SQRZ team replies within 24 hours, usually under 12.",
    type: "system",
    user_id: SQRZ_SYSTEM_USER_ID,
  } as Record<string, unknown>);
}

// Posted once per REQUEST (not per channel) — carries campaign_id/
// template_id as the MESSAGE's own custom data (not the channel's), which is
// what ensureSupportThread checks to tell whether this particular request's
// summary has already been posted into the profile's shared channel.
async function postRequestSummary(
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
    campaign_id: row.id,
    template_id: row.campaign_template,
  } as Record<string, unknown>);
}

/**
 * Ensures the PROFILE's support channel exists — creating it on first use
 * (the caller, api.messaging.support-thread.ts, upserts the customer's own
 * Stream user BEFORE calling this, since channel.create() sets
 * created_by_id/members to that id, which Stream rejects if the user
 * doesn't exist yet) — or returns the existing one, REPAIRING anything
 * that's missing along the way: a channel can exist without being fully
 * set up (e.g. created client-side earlier, outside this flow). Checked and
 * filled in independently, never overwriting a value that's already set:
 *   - kind / profile_id (channel custom data)
 *   - name / image (resolveChannelDisplay)
 *   - the customer's own membership
 *   - every Lab account's team user's membership (ensureLabTeamMembership)
 *
 * The one-time welcome message (postWelcomeMessage) is the one thing that's
 * NOT part of repair — it's posted only at the moment a channel is actually
 * created here, never again after that and never for an existing (even if
 * otherwise-repaired) channel.
 */
async function ensureChannelExists(profileId: string): Promise<{ channel: any; isNewChannel: boolean }> {
  const channelId = toSupportChannelId(profileId);
  const customerStreamUserId = toStreamUserIdForProfile(profileId);

  const existing = await queryStreamChannelById(channelId);

  let channel = existing;
  let isNewChannel = false;

  if (channel) {
    const data = (channel.data as any) ?? {};
    const update: Record<string, unknown> = {};
    if (data.kind !== SUPPORT_CHANNEL_KIND) update.kind = SUPPORT_CHANNEL_KIND;
    if (data.profile_id !== profileId) update.profile_id = profileId;
    if (!data.name || !data.image) {
      const { name, image } = await resolveChannelDisplay(profileId);
      if (!data.name) update.name = name;
      if (!data.image) update.image = image;
    }
    if (Object.keys(update).length) {
      await channel.update(update as Record<string, unknown>);
    }
    await ensureMember(channel, customerStreamUserId);
  } else {
    const { name, image } = await resolveChannelDisplay(profileId);
    const client = getStreamServerClient();
    channel = client.channel(STREAM_CHANNEL_TYPE, channelId, {
      created_by_id: customerStreamUserId,
      members: [customerStreamUserId],
      kind: SUPPORT_CHANNEL_KIND,
      profile_id: profileId,
      name,
      image,
    } as Record<string, unknown>);
    await channel.create();
    isNewChannel = true;
  }

  if (isNewChannel) {
    await postWelcomeMessage(channel);
  }

  await ensureLabTeamMembership(channel);

  return { channel, isNewChannel };
}

/**
 * Ensures the requesting profile's shared support channel exists/is
 * repaired (see ensureChannelExists), then posts `row`'s own request
 * summary exactly once per request: checked by scanning the channel's
 * already-fetched messages for one whose own custom data carries this
 * request's campaign_id — if none is found (a request that hasn't been
 * posted yet, whether because the channel is brand new or this is a later
 * request in an existing channel), the summary is posted now.
 */
export async function ensureSupportThread(row: ManagedRequestRow): Promise<{ channelId: string }> {
  const channelId = toSupportChannelId(row.profile_id);
  const { channel, isNewChannel } = await ensureChannelExists(row.profile_id);

  // A brand-new channel can never already contain this (or any) request's
  // summary — skip the message scan and post unconditionally. For an
  // existing channel, check whether this specific request has already had
  // its summary posted.
  const alreadyPosted = isNewChannel
    ? false
    : ((channel.state?.messages ?? []) as any[]).some((m) => m?.campaign_id === row.id);

  if (!alreadyPosted) {
    const admin = createSupabaseAdminClient();
    const { data: template } = row.campaign_template
      ? await admin.from("campaign_templates").select("name").eq("id", row.campaign_template).maybeSingle()
      : { data: null };
    const templateName = (template as { name: string } | null)?.name ?? null;
    await postRequestSummary(channel, row, templateName);
  }

  return { channelId };
}

/**
 * General support (no request) — ensures/repairs the profile's shared
 * support channel exactly like ensureSupportThread, but never posts a
 * request summary message (there's no request).
 */
export async function ensureSupportChannel(profileId: string): Promise<{ channelId: string }> {
  const channelId = toSupportChannelId(profileId);
  await ensureChannelExists(profileId);
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
 * of every existing (current, per-profile — see EXCLUDE_LEGACY_CHANNEL_FILTER)
 * support channel, so a team member who gets Lab access later still sees
 * older threads. Returns a 1-hour Stream token for that identity, same
 * format as createStreamUserToken.
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
    { type: STREAM_CHANNEL_TYPE, kind: SUPPORT_CHANNEL_KIND, ...EXCLUDE_LEGACY_CHANNEL_FILTER } as any,
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
