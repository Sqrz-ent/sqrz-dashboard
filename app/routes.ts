import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // Auth (public)
  route("join", "routes/join.tsx"),
  route("login", "routes/login.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),

  // Protected app (session required)
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("office", "routes/_app.office.tsx"),
    route("crew", "routes/_app.crew.tsx"),
  ]),

  // Starter template files (kept for reference, not linked in UI)
  route("home", "routes/home.tsx"),
  route(".well-known/*", "routes/.well-known.$.tsx"),
] satisfies RouteConfig;
