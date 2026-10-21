// Shared Apple JWS verification (2026-10-21) — extracted verbatim from
// apple-subscription-webhook (the ONLY place this logic lived before) so
// verify-campaign-activation and apple-consumable-webhook reuse the exact
// same verification instead of each carrying their own copy. No logic
// changed from the original — same x5c-chain-to-pinned-Apple-Root-CA check,
// same ES256 compactVerify. Works for ANY Apple JWS: a notification
// envelope, signedTransactionInfo, signedRenewalInfo, or a StoreKit 2
// client-side Transaction.jwsRepresentation — they're all the same format.

import { compactVerify, decodeProtectedHeader, importX509 } from "npm:jose@5";
import { X509Certificate } from "node:crypto";
import { Buffer } from "node:buffer";

// Apple Root CA - G3 — the root of the x5c chain in every Apple-signed JWS.
// Fetched once per isolate from Apple and cached; verification FAILS CLOSED
// (caller should treat a thrown "root CA fetch" error as retryable/5xx).
const APPLE_ROOT_CA_URL = "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer";
let appleRootDer: Buffer | null = null;

async function getAppleRoot(): Promise<Buffer> {
  if (appleRootDer) return appleRootDer;
  const res = await fetch(APPLE_ROOT_CA_URL);
  if (!res.ok) throw new Error(`Apple root CA fetch failed: ${res.status}`);
  appleRootDer = Buffer.from(await res.arrayBuffer());
  return appleRootDer;
}

// Verifies one Apple JWS: x5c chain of [leaf, intermediate, root], root must
// byte-equal the pinned Apple Root CA, each cert must be signed by the next,
// and the JWS signature must verify against the leaf key.
export async function verifyAppleJws(jws: string): Promise<Record<string, unknown>> {
  const header = decodeProtectedHeader(jws);
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 3) {
    throw new Error("missing or short x5c chain");
  }

  const certs = x5c.map((b64) => new X509Certificate(Buffer.from(b64, "base64")));
  const root = certs[certs.length - 1];

  const pinnedRoot = await getAppleRoot();
  if (!root.raw.equals(pinnedRoot)) {
    throw new Error("x5c root is not Apple Root CA - G3");
  }
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new Error(`x5c chain broken at index ${i}`);
    }
  }

  const leafKey = await importX509(certs[0].toString(), "ES256");
  const { payload } = await compactVerify(jws, leafKey);
  return JSON.parse(new TextDecoder().decode(payload));
}
