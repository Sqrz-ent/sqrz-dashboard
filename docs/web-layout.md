# Web dashboard layout

One frame for every authenticated page (`app/routes/_app.tsx`), mirroring the iOS app
(`sqrz-ios`): `MainTabView`, `DashboardShellView`, `GrowTabView`. The navigation model lives in
`app/lib/nav.ts` (single source; tested) — pages never render their own header, title or container.

| Part | Behaviour |
|---|---|
| Header (all pages, same on every one) | Logo left; balance, **Top up** and the profile switcher right. |
| Main navigation = the iOS tabs | **Profile · Leads · Grow · Preview** (same names/order). Desktop: in the header next to the logo. Mobile: bottom bar; the mobile header keeps only logo, balance, Top up, switcher. *Preview* opens the public page in a new tab. |
| Account | In the profile switcher menu (like the iOS avatar sheet), not a main nav item. `/account` is also the last pill of the Profile tab, as on iOS. |
| Sub-sections | A pill row under the page title (the Grow pill style): Profile tab → **Dashboard · Profile · Business · Account**; Grow → **Grow · Campaigns · Links · Analytics**; Leads has none. |
| Content container | One max width (1140px) and left edge for header, title, pills and content. Narrow content (forms, lists) is left-aligned inside it at its own max width; only the campaign kanban uses the full width. |

URLs are unchanged (`/`, `/profile`, `/service`, `/account`, `/office`, `/analytics?tab=…`,
`/notifications`), so no redirects were needed. A page's own `<h1>` was removed where the shared title
and the active pill already name it (Profile, Business, Account, Leads, Grow).
Visibility of the two navs is by classes only (`hidden md:flex` / `flex md:hidden`) — an inline `display`
would override them (the old bottom bar did, and showed on desktop too).
