import { createHmac } from "node:crypto";

// Stream token minting for inquiry chat identities. The booking-messaging machinery
// that used to live here (channel creation, member sync, booking_channels persistence)
// was removed 2026-07-31 alongside the staged booking pipeline — all of it had zero
// callers (booking chat's own UI consumer was already removed earlier; see root
// CLAUDE.md's Messaging section). Only what inquiry.server.ts actually uses remains.

function getStreamEnv() {
  const apiKey = process.env.STREAM_API_KEY;
  const apiSecret = process.env.STREAM_API_SECRET;

  if (!apiKey) throw new Error("STREAM_API_KEY is not set");
  if (!apiSecret) throw new Error("STREAM_API_SECRET is not set");

  return { apiKey, apiSecret };
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

export function toStreamUserIdForProfile(profileId: string) {
  return `profile_${profileId}`;
}
