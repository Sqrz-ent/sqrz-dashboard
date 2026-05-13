import Stripe from "stripe";

export type StripeMode = "live" | "test";

export function getStripeSecretKey(mode: StripeMode): string | null {
  if (mode === "test") {
    return process.env.STRIPE_SECRET_KEY_TEST ?? null;
  }
  return process.env.STRIPE_SECRET_KEY ?? null;
}

export function getStripeClient(mode: StripeMode): Stripe | null {
  const secretKey = getStripeSecretKey(mode);
  if (!secretKey) return null;
  return new Stripe(secretKey, {
    apiVersion: "2026-02-25.clover",
  });
}

export function resolveStripeMode(input: string | null | undefined, isBeta: boolean): StripeMode {
  if (isBeta && input === "test") return "test";
  return "live";
}

export function isStripeModeAvailable(mode: StripeMode): boolean {
  return !!getStripeSecretKey(mode);
}
