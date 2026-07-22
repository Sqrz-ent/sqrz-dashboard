import { redirect } from "react-router";
import type { Route } from "./+types/api.stripe.connect";
import {
  createSupabaseServerClient,
  createSupabaseBearerClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getStripeClient, resolveStripeMode, type StripeMode } from "~/lib/stripe-mode.server";
import { getPlanLevel, FEATURE_GATES } from "~/lib/plans";

// Native callers (sqrz-ios) authenticate with a Bearer access token. This loader runs
// before anything tries to treat the request as a browser navigation: a Bearer request
// resolves here with JSON instead of being redirected to the login page. The actual
// onboarding work always happens in action() — this only needs to NOT redirect.
export async function loader({ request }: Route.LoaderArgs) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // Browser requests have no Bearer header — let normal routing proceed untouched.
  if (!bearerToken) return null;

  const supabase = createSupabaseBearerClient(bearerToken);
  const {
    data: { user },
  } = await supabase.auth.getUser(bearerToken);

  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return Response.json({ ok: true });
}

export async function action({ request }: Route.ActionArgs) {
  // Native callers (sqrz-ios) authenticate with a Bearer access token and expect a
  // JSON response; the browser flow authenticates via cookies and expects a redirect.
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const isNative = bearerToken != null;

  let headers = new Headers();
  let supabase;
  let user;

  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({
      data: { user },
    } = await supabase.auth.getUser(bearerToken));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  } else {
    ({ supabase, headers } = createSupabaseServerClient(request));
    ({
      data: { user },
    } = await supabase.auth.getUser());
    if (!user) return redirect("/login", { headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return isNative
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : redirect("/login", { headers });
  }

  const url = new URL(request.url);
  const contentType = request.headers.get("Content-Type") ?? "";
  const isJson = contentType.includes("application/json");
  const isBeta = Boolean(profile.is_beta);

  // Native (sqrz-ios) callers send JSON. Read `mode` from the body and run it through the
  // same is_beta gate as the browser flow — a non-beta caller can never reach test mode.
  let mode: StripeMode;
  let returnTo: string;
  if (isJson) {
    const body = (await request.json().catch(() => ({}))) as { mode?: string | null };
    mode = resolveStripeMode(body.mode ?? url.searchParams.get("mode"), isBeta);
    returnTo = "payments";
  } else {
    const formData = await request.formData();
    mode = resolveStripeMode(
      (formData.get("mode") as string | null) ?? url.searchParams.get("mode"),
      isBeta
    );
    returnTo = url.searchParams.get("returnTo") ?? "payments";
  }

  // Server-side feature gate: onboarding a Connect account to receive booking
  // payouts requires Creator+. Enforced independently of the client-side `locked`
  // gate on the payments page so a free user can't reach account creation by
  // POSTing directly. The partners onboarding path (returnTo=partners) is gated
  // by is_partner, not plan tier, so it is exempt.
  if (returnTo !== "partners" && getPlanLevel(profile.plan_id as number | null) < FEATURE_GATES.payments) {
    return isNative
      ? Response.json({ error: "Payments require a paid plan" }, { status: 403 })
      : Response.json({ ok: false, error: "Payments require a paid plan" }, { status: 403, headers });
  }

  const stripeConnect = getStripeClient(mode);
  if (!stripeConnect) {
    return Response.json({ error: `Stripe ${mode} mode is not configured.` }, { status: 500, headers });
  }

  const publicUrl = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";
  const returnPath = returnTo === "partners" ? "/partners" : "/payments";
  const returnModeParam = mode === "test" ? "&mode=test" : "";

  const connectIdField = mode === "test" ? "stripe_connect_id_test" : "stripe_connect_id";
  const connectStatusField = mode === "test" ? "stripe_connect_status_test" : "stripe_connect_status";
  let connectId = profile[connectIdField] as string | undefined;

  if (!connectId) {
    const account = await stripeConnect.accounts.create({
      type: "express",
      email: (profile.email as string) ?? undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        profile_id: profile.id as string,
        slug: (profile.slug as string) ?? "",
      },
    });

    connectId = account.id;

    // Persist immediately so the webhook can match it
    await supabase
      .from("profiles")
      .update({
        [connectIdField]: connectId,
        [connectStatusField]: "pending",
        ...(mode === "test" ? { stripe_beta_test_mode: true } : {}),
      })
      .eq("id", profile.id);
  }

  // Native callers return to an https pass-through page that re-opens the app via the
  // sqrz:// custom scheme — Stripe AccountLink rejects custom schemes directly. The
  // browser flow returns to the relevant dashboard page.
  const refreshUrl = isNative
    ? "https://dashboard.sqrz.com/payments"
    : `${publicUrl}${returnPath}?connect=refresh${returnModeParam}`;
  const returnUrl = isNative
    ? "https://dashboard.sqrz.com/stripe-return"
    : `${publicUrl}${returnPath}?connect=success${returnModeParam}`;

  // Create onboarding link
  const accountLink = await stripeConnect.accountLinks.create({
    account: connectId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });

  // iOS expects JSON; the browser expects a redirect.
  if (isNative) {
    return Response.json({ url: accountLink.url });
  }

  return redirect(accountLink.url, { headers });
}
