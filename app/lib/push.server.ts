import webpush from "web-push";

import { createSupabaseAdminClient } from "~/lib/supabase.server";

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type PushPayload = {
  title: string;
  body: string;
  targetUrl: string;
  tag?: string;
};

function getPushEnv() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  return {
    publicKey: publicKey ?? "",
    privateKey: privateKey ?? "",
    subject: subject ?? "mailto:hello@sqrz.com",
  };
}

export function isPushConfigured() {
  const { publicKey, privateKey, subject } = getPushEnv();
  return !!publicKey && !!privateKey && !!subject;
}

export function getPushPublicKey() {
  return getPushEnv().publicKey;
}

function getWebPushClient() {
  const { publicKey, privateKey, subject } = getPushEnv();
  if (!publicKey || !privateKey) {
    throw new Error("Web Push is not configured");
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  return webpush;
}

export async function savePushSubscription(input: {
  profileId: string;
  userId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  platform?: string | null;
  userAgent?: string | null;
  appScope?: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();

  const { error } = await admin
    .from("push_subscriptions")
    .upsert(
      {
        profile_id: input.profileId,
        user_id: input.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        platform: input.platform ?? null,
        user_agent: input.userAgent ?? null,
        app_scope: input.appScope ?? null,
        is_active: true,
        last_seen_at: now,
        updated_at: now,
      },
      { onConflict: "endpoint" }
    );

  if (error) {
    throw new Error(error.message);
  }
}

export async function deactivatePushSubscription(endpoint: string) {
  const admin = createSupabaseAdminClient();
  await admin
    .from("push_subscriptions")
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("endpoint", endpoint);
}

async function loadActiveSubscriptions(profileId: string) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("profile_id", profileId)
    .eq("is_active", true);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as StoredSubscription[];
}

export async function sendNotificationEvent(input: {
  profileId: string;
  recipientProfileId: string;
  actorProfileId?: string | null;
  type: "inquiry_message" | "booking_message";
  sourceId: string;
  title: string;
  body: string;
  targetUrl: string;
}) {
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();

  const { data: inserted, error: insertError } = await admin
    .from("notification_events")
    .insert({
      profile_id: input.profileId,
      actor_profile_id: input.actorProfileId ?? null,
      recipient_profile_id: input.recipientProfileId,
      type: input.type,
      source_id: input.sourceId,
      title: input.title,
      body: input.body,
      target_url: input.targetUrl,
      status: "pending",
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (insertError || !inserted?.id) {
    throw new Error(insertError?.message ?? "Failed to create notification event");
  }

  if (!isPushConfigured()) {
    await admin
      .from("notification_events")
      .update({
        status: "failed",
        last_error: "Web Push is not configured",
        delivery_attempts: 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", inserted.id);
    throw new Error("Web Push is not configured");
  }

  const subscriptions = await loadActiveSubscriptions(input.recipientProfileId);
  if (!subscriptions.length) {
    await admin
      .from("notification_events")
      .update({
        status: "failed",
        last_error: "No active subscriptions",
        delivery_attempts: 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", inserted.id);
    return { sent: 0, eventId: inserted.id };
  }

  const payload: PushPayload = {
    title: input.title,
    body: input.body,
    targetUrl: input.targetUrl,
    tag: `${input.type}:${input.sourceId}`,
  };

  const client = getWebPushClient();
  let sent = 0;
  let attempts = 0;
  let lastError: string | null = null;

  for (const subscription of subscriptions) {
    attempts += 1;
    try {
      await client.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        JSON.stringify(payload)
      );
      sent += 1;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : null;
      const message = error instanceof Error ? error.message : "Failed to send push";
      lastError = message;

      if (statusCode === 404 || statusCode === 410) {
        await deactivatePushSubscription(subscription.endpoint);
      }
    }
  }

  await admin
    .from("notification_events")
    .update({
      status: sent > 0 ? "sent" : "failed",
      delivery_attempts: attempts,
      last_error: sent > 0 ? null : lastError,
      sent_at: sent > 0 ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", inserted.id);

  return { sent, eventId: inserted.id };
}
