import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // Auth (public)
  route("join", "routes/join.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),

  // Protected app (session required)
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
  ]),

  // Existing routes (kept outside protected layout for now)
  route("profile", "routes/profile.tsx"),

  // Starter template files (kept for reference, not linked in UI)
  route("home", "routes/home.tsx"),
  route(".well-known/*", "routes/.well-known.$.tsx"),
] satisfies RouteConfig;
