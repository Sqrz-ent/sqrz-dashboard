-- Beta-only campaign templates: regular users see only 'public' templates;
-- accounts flagged is_beta=true also see 'beta' ones. Lets Will test a large
-- catalogue without showing it to everyone.

ALTER TABLE campaign_templates
  ADD COLUMN visibility text NOT NULL DEFAULT 'public'
  CHECK (visibility = ANY (ARRAY['public', 'beta']));
COMMENT ON COLUMN campaign_templates.visibility IS
  'public = visible to all authenticated users. beta = visible only to accounts with is_beta = true. Default public; existing rows unaffected.';

ALTER TABLE accounts
  ADD COLUMN is_beta boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN accounts.is_beta IS
  'Sees beta templates. Set manually.';

-- SECURITY DEFINER so the campaign_templates policy below can check the
-- caller's own account without depending on accounts' own RLS allowing it
-- (it currently does, via accounts_owner_read, but this keeps the check
-- self-contained and matches the existing user_owns_account/user_owns_profile
-- helper pattern rather than relying on that incidentally).
CREATE OR REPLACE FUNCTION public.caller_account_is_beta()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select exists (
    select 1 from accounts where user_id = auth.uid() and is_beta = true
  );
$$;

DROP POLICY IF EXISTS campaign_templates_read ON campaign_templates;
CREATE POLICY campaign_templates_read ON campaign_templates
  FOR SELECT TO authenticated
  USING (
    status <> 'hidden'
    AND (visibility = 'public' OR public.caller_account_is_beta())
  );
-- No INSERT/UPDATE/DELETE policies — this table has never had client writes
-- (edited directly by Will, see the table's own comment); unchanged by this
-- migration.
