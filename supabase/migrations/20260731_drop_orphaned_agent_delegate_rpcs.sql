-- profile_delegates was dropped in the leads-only-model migration (2026-07-31).
-- create_managed_profile/get_agent_roster reference it and have zero callers
-- anywhere in app code (agent mode was already fully retired from the UI) —
-- orphaned, would error if ever invoked. Drop them.
-- Applied via apply_migration on 2026-07-31.
drop function if exists public.create_managed_profile(text, text, uuid);
drop function if exists public.get_agent_roster(uuid);
