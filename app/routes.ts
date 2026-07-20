import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // Auth (public)
  route("join", "routes/join.tsx"),
  route("login", "routes/login.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
  route("claim", "routes/claim.tsx"),
  route("claim/confirm", "routes/claim.confirm.tsx"),

  // Standalone booking access (no dashboard chrome)
  route("booking/:id", "routes/booking.$id.tsx"),

  // Stripe Connect native return pass-through (no auth — re-opens sqrz:// app)
  route("stripe-return", "routes/stripe-return.tsx"),

  // Protected app (session required)
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("office", "routes/_app.office.tsx"),
    route("partners", "routes/_app.partners.tsx"),
    route("partner-onboarding", "routes/_app.partner-onboarding.tsx"),
    route("office/admin/payouts", "routes/_app.office.admin.payouts.tsx"),
    route("crew", "routes/_app.crew.tsx"),
    route("profile", "routes/_app.profile.tsx"),
    route("service", "routes/_app.service.tsx"),
    route("payments", "routes/_app.payments.tsx"),
    route("boost", "routes/_app.boost.tsx"),
    route("domain", "routes/_app.domain.tsx"),
    route("links", "routes/_app.links.tsx"),
    route("account", "routes/_app.account.tsx"),
    route("analytics", "routes/_app.analytics.tsx"),
    route("notifications", "routes/_app.notifications.tsx"),
  ]),

  // API routes (server-only, action handlers)
  route("api/messaging/stream-token", "routes/api.messaging.stream-token.ts"),
  route("api/messaging/stream-inbox", "routes/api.messaging.stream-inbox.ts"),
  route("api/messaging/stream-inquiry", "routes/api.messaging.stream-inquiry.ts"),
  route("api/messaging/stream-inquiry-convert", "routes/api.messaging.stream-inquiry-convert.ts"),
  route("api/messaging/stream-inquiry-status", "routes/api.messaging.stream-inquiry-status.ts"),
  route("api/dashboard/home-summary", "routes/api.dashboard.home-summary.ts"),
  route("api/booking/create", "routes/api.booking.create.tsx"),
  route("api/booking/deliver", "routes/api.booking.deliver.tsx"),
  route("api/proposal/accept", "routes/api.proposal.accept.tsx"),
  route("api/proposal/counter", "routes/api.proposal.counter.tsx"),
  route("api/proposal/decline", "routes/api.proposal.decline.tsx"),
  route("api/payout", "routes/api.payout.tsx"),
  route("api/wallet/allocation", "routes/api.wallet.allocation.tsx"),

  // Links API
  route("api/links/:linkId/leads-csv", "routes/api.links.$linkId.leads-csv.tsx"),

  // Campaign checkout (unified Boost + Grow)
  route("api/campaigns/checkout", "routes/api.campaigns.checkout.tsx"),

  // Campaign AI advisor (forwards to the campaign-advisor edge function)
  route("api/campaign-advisor", "routes/api.campaign-advisor.tsx"),

  // Stripe API routes (server-only, action handlers)
  route("api/stripe/checkout", "routes/api.stripe.checkout.tsx"),
  route("api/stripe/connect", "routes/api.stripe.connect.tsx"),
  route("api/stripe/connect/login", "routes/api.stripe.connect.login.tsx"),
  route("api/stripe/billing-portal", "routes/api.stripe.billing-portal.tsx"),
  route("api/stripe/cancel-subscription", "routes/api.stripe.cancel-subscription.tsx"),
  route("api/stripe/webhook", "routes/api.stripe.webhook.tsx"),

  // Starter template files (kept for reference, not linked in UI)
  route("home", "routes/home.tsx"),
  route(".well-known/*", "routes/.well-known.$.tsx"),
] satisfies RouteConfig;
