-- grow_clients was dropped in the leads-only-model migration (2026-07-31).
-- get_grow_client_status() reads it and has zero callers anywhere in app code
-- (confirmed) — orphaned, would error if ever invoked. Drop it.
-- Applied via apply_migration on 2026-07-31.
drop function if exists public.get_grow_client_status();
