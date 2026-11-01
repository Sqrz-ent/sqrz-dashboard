// Auth guard for every sandbox-* edge function.
//
// Mirrors the "shared secret in a header" pattern of meta-campaign-create /
// meta-insights-sync (x-sync-secret), but the secret is the plain function
// secret SANDBOX_ADMIN_KEY (no Vault RPC — the sandbox must not depend on
// anything in the live schema). Deploy sandbox functions with verify_jwt:false.
//
// Fails closed: if SANDBOX_ADMIN_KEY is unset, every request is a 401.

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time string compare (length leak is acceptable for a fixed-length key). */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Returns a 401 Response when the request is not allowed, or null when it is. */
export function requireSandboxKey(req: Request): Response | null {
  const expected = Deno.env.get("SANDBOX_ADMIN_KEY") ?? "";
  const provided = req.headers.get("x-sandbox-key") ?? "";
  if (!expected) {
    console.error("[sandbox-guard] SANDBOX_ADMIN_KEY is not set — rejecting all requests");
    return json({ error: "unauthorized" }, 401);
  }
  if (!provided || !safeEqual(provided, expected)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}
