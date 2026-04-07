import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // Auth (public)
  route("join", "routes/join.tsx"),
  route("login", "routes/login.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
  route("guest-login", "routes/guest-login.tsx"),
  route("claim", "routes/claim.tsx"),
  route("claim/confirm", "routes/claim.confirm.tsx"),
  route("guest-access", "routes/guest-access.tsx"),

  // Standalone booking access (no dashboard chrome)
  route("booking/:id", "routes/booking.$id.tsx"),

  // Protected app (session required)
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("office", "routes/_app.office.tsx"),
    route("crew", "routes/_app.crew.tsx"),
    route("profile", "routes/_app.profile.tsx"),
    route("service", "routes/_app.service.tsx"),
    route("payments", "routes/_app.payments.tsx"),
    route("boost", "routes/_app.boost.tsx"),
    route("domain", "routes/_app.domain.tsx"),
    route("links", "routes/_app.links.tsx"),
    route("account", "routes/_app.account.tsx"),
  ]),

  // API routes (server-only, action handlers)
  route("api/notify-guest", "routes/api.notify-guest.tsx"),

  // Stripe API routes (server-only, action handlers)
  route("api/stripe/checkout", "routes/api.stripe.checkout.tsx"),
  route("api/stripe/connect", "routes/api.stripe.connect.tsx"),
  route("api/stripe/connect/login", "routes/api.stripe.connect.login.tsx"),
  route("api/stripe/billing-portal", "routes/api.stripe.billing-portal.tsx"),
  route("api/stripe/webhook", "routes/api.stripe.webhook.tsx"),

  // Starter template files (kept for reference, not linked in UI)
  route("home", "routes/home.tsx"),
  route(".well-known/*", "routes/.well-known.$.tsx"),
] satisfies RouteConfig;
