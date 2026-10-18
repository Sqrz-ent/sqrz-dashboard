-- Follow-up to 20261018_multi_profile_ownership.sql.
--
-- `create or replace function get_dashboard_home(p_profile_id uuid default null)`
-- does NOT replace the original zero-argument `get_dashboard_home()` --
-- Postgres treats a different arity as a distinct overload, not a
-- replacement. That left TWO functions behind (the original zero-arg one,
-- untouched, plus the new one-arg-with-default one), which makes a
-- zero-argument call ambiguous -- exactly the call shape the current
-- TestFlight build uses for both RPCs. Caught by re-running the
-- single-profile backward-compat check from that migration's own "Verify"
-- step immediately after applying it.
--
-- Fix: drop the stale zero-arg overloads so the one-arg-with-default
-- version is the sole candidate again, callable with 0 or 1 arguments.
drop function if exists public.get_dashboard_home();
drop function if exists public.get_companion_subscription_status();
