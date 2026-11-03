import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // Auth (public)
  // /join is a redirect to /login — web signup was retired (accounts are
  // created in the iOS app); kept so old links don't 404.
  route("join", "routes/join.tsx"),
  route("login", "routes/login.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
  // Signed-in users without SQRZ Pro land here (every dashboard route redirects
  // to it). Public/outside the _app layout so it can never redirect-loop.
  route("pro-required", "routes/pro-required.tsx"),
  // Old standalone Campaigns URLs → their new place inside Grow.
  route("campaigns", "routes/legacy-campaigns.tsx"),
  route("campaigns/:id", "routes/legacy-campaign.tsx"),
  // Grow itself used to live at /analytics (moved to /grow) — permanent
  // redirects for every old /analytics URL, query string preserved.
  route("analytics", "routes/legacy-analytics.tsx"),
  route("analytics/campaigns/new/:templateId", "routes/legacy-analytics-campaign-new.tsx"),
  route("analytics/campaigns/:id", "routes/legacy-analytics-campaign.tsx"),
  route("analytics/links/:id", "routes/legacy-analytics-link.tsx"),

  // Protected app (session required)
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("office", "routes/_app.office.tsx"),
    route("profile", "routes/_app.profile.tsx"),
    route("service", "routes/_app.service.tsx"),
    route("account", "routes/_app.account.tsx"),
    route("grow", "routes/_app.grow.tsx"),
    // Read-only campaign detail — a sub-route of Grow (the pipeline itself is on
    // the Grow page, /grow; managing campaigns stays in the iOS app)
    route("grow/campaigns/new/:templateId", "routes/_app.grow.campaigns.new.$templateId.tsx"),
    route("grow/campaigns/:id", "routes/_app.grow.campaigns.$id.tsx"),
    route("grow/links/:id", "routes/_app.grow.links.$id.tsx"),
    route("notifications", "routes/_app.notifications.tsx"),
  ]),

  // API routes (server-only, action handlers)
  // Switch the active profile (web header switcher) — sets the preference cookie.
  route("api/active-profile", "routes/api.active-profile.tsx"),
  // City search for campaign location targeting (Nominatim proxy; Pro + cookie auth)
  route("api/location-search", "routes/api.location-search.tsx"),
  // Inquiry chat: token/thread list, Keep Active (bump lead active). Archive
  // (the old stream-inquiry-status route) and the thread→booking convert
  // route were both removed — Archive now happens via the set_lead_status
  // RPC directly from the Leads tab.
  route("api/messaging/stream-inquiry", "routes/api.messaging.stream-inquiry.ts"),
  route("api/messaging/stream-inquiry-keep-active", "routes/api.messaging.stream-inquiry-keep-active.ts"),

  // On-demand single-campaign Meta + SQRZ-native stats refresh
  route("api/campaigns/refresh-stats", "routes/api.campaigns.refresh-stats.tsx"),

  // Grow ad-spend wallet top-up (web + iOS, same Stripe flow)
  route("api/wallet/topup", "routes/api.wallet.topup.tsx"),
  // Bank-transfer wallet top-up (web user side; proxies the wire-topup-create edge function)
  route("api/wire-topup", "routes/api.wire-topup.tsx"),

  // Free-tier campaign-activation budget payment ("Card" option, 2026-10-21
  // follow-up) — pays exactly one awaiting_budget campaign's ad budget via
  // the same Stripe Checkout flow as the wallet top-up above, tagged with
  // campaign_id so api/stripe/webhook.tsx also allocates + launches it.
  route("api/campaigns/budget-checkout", "routes/api.campaigns.budget-checkout.tsx"),

  // Campaign AI advisor (forwards to the campaign-advisor edge function)
  route("api/campaign-advisor", "routes/api.campaign-advisor.tsx"),
  // Goal-to-template AI advisor (2026-11 rework) — forwards to the
  // profile-advisor edge function, which recommends 1-3 campaign templates
  // for the artist's own free-text goal.
  route("api/profile-advisor", "routes/api.profile-advisor.tsx"),

  // In-app account deletion — iOS-only, forwards to the delete-account edge
  // function (Apple token revocation + anonymize-in-place + external cleanup).
  route("api/delete-account", "routes/api.delete-account.tsx"),

  // Stripe API routes (server-only, action handlers)
  route("api/stripe/webhook", "routes/api.stripe.webhook.tsx"),

  route(".well-known/*", "routes/.well-known.$.tsx"),
] satisfies RouteConfig;
