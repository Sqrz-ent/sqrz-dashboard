-- Credentials feature removed from the dashboard (was beta-only on /service).
-- CASCADE removes the table's trigger, policies and FKs. The three enums were
-- verified to be used ONLY by this table (no other columns, no function args),
-- and update_credential_updated_at() was the table's own updated_at trigger
-- function (CASCADE drops the trigger but not the function).
-- The `credentials` storage bucket is intentionally left untouched.
DROP TABLE IF EXISTS credential_declarations CASCADE;

DROP TYPE IF EXISTS credential_type;
DROP TYPE IF EXISTS credential_visibility;
DROP TYPE IF EXISTS credential_status;

DROP FUNCTION IF EXISTS update_credential_updated_at();
