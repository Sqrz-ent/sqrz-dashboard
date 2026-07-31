import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // Auth (public)
  route("join", "routes/join.tsx"),
  route("login", "routes/login.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
  route("claim", "routes/claim.tsx"),
  route("claim/confirm", "routes/claim.confirm.tsx"),

  // Protected app (session required)
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("office", "routes/_app.office.tsx"),
    route("invites", "routes/_app.invites.tsx"),
    route("invite-onboarding", "routes/_app.invite-onboarding.tsx"),
    route("partners", "routes/_app.partners.tsx"),
    route("partner-onboarding", "routes/_app.partner-onboarding.tsx"),
    route("profile", "routes/_app.profile.tsx"),
    route("service", "routes/_app.service.tsx"),
    route("boost", "routes/_app.boost.tsx"),
    route("domain", "routes/_app.domain.tsx"),
    route("links", "routes/_app.links.tsx"),
    route("account", "routes/_app.account.tsx"),
    route("analytics", "routes/_app.analytics.tsx"),
    route("notifications", "routes/_app.notifications.tsx"),
  ]),

  // API routes (server-only, action handlers)
  // Inquiry chat: token/thread list, Archive (close thread + archive lead),
  // Keep Active (bump lead active). The old thread→booking convert route was removed.
  route("api/messaging/stream-inquiry", "routes/api.messaging.stream-inquiry.ts"),
  route("api/messaging/stream-inquiry-status", "routes/api.messaging.stream-inquiry-status.ts"),
  route("api/messaging/stream-inquiry-keep-active", "routes/api.messaging.stream-inquiry-keep-active.ts"),
  route("api/dashboard/home-summary", "routes/api.dashboard.home-summary.ts"),

  // Links API
  route("api/links/:linkId/leads-csv", "routes/api.links.$linkId.leads-csv.tsx"),

  // Campaign checkout (unified Boost + Grow)
  route("api/campaigns/checkout", "routes/api.campaigns.checkout.tsx"),
  // Reactivate an exhausted campaign ($10 Stripe checkout)
  route("api/campaigns/reactivate", "routes/api.campaigns.reactivate.tsx"),

  // Grow ad-spend wallet top-up (web + iOS, same Stripe flow)
  route("api/wallet/topup", "routes/api.wallet.topup.tsx"),

  // Campaign AI advisor (forwards to the campaign-advisor edge function)
  route("api/campaign-advisor", "routes/api.campaign-advisor.tsx"),

  // Stripe API routes (server-only, action handlers)
  route("api/stripe/webhook", "routes/api.stripe.webhook.tsx"),

  // Starter template files (kept for reference, not linked in UI)
  route("home", "routes/home.tsx"),
  route(".well-known/*", "routes/.well-known.$.tsx"),
] satisfies RouteConfig;
