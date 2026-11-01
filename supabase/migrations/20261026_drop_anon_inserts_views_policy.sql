-- Applied 2026-10-26 by hand in the Supabase SQL editor, after
-- 20261026_analytics_access_lockdown.sql. That migration already revoked
-- client INSERT on profile_views (making this policy inert); this removes
-- the leftover policy itself. Verified afterwards: profile_views has no
-- policies; all writes go through the profile pages' /api/track-view
-- (service role, which bypasses RLS).
drop policy if exists anon_inserts_views on public.profile_views;
