-- Lab accounts see campaign templates for non-Meta outlets; everyone else
-- sees Meta templates only.   NOT APPLIED — review, then apply manually.
--
-- Reuses the existing beta-visibility mechanism (20261024_campaign_templates_
-- beta_visibility.sql): an account-level boolean set by hand, a SECURITY
-- DEFINER caller_account_is_* helper, and the campaign_templates_read RLS
-- policy. The new rule is ANDed on, independent of visibility/is_beta.
-- No data is written or seeded here: existing rows get outlet = 'meta' via
-- the column default, and no accounts are flagged.

-- 1. Account-level flag. Set manually (like accounts.is_beta / profiles.is_partner).
ALTER TABLE accounts
  ADD COLUMN is_lab boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN accounts.is_lab IS
  'Sees campaign templates for non-Meta outlets (campaign_templates.outlet <> ''meta''). Set manually. No client can write this table (accounts_owner_read is its only policy).';

-- 2. Which ad platform a template belongs to. Routing key for the iOS app
--    (distinct from the display-only `outlets` jsonb pill labels). Lowercase
--    token so app-side routing never has to deal with casing/whitespace.
ALTER TABLE campaign_templates
  ADD COLUMN outlet text NOT NULL DEFAULT 'meta'
  CHECK (outlet ~ '^[a-z0-9_]+$');
COMMENT ON COLUMN campaign_templates.outlet IS
  'Ad platform this template runs on, e.g. ''meta'', ''google''. Drives routing in the app: ''meta'' opens the existing create-campaign sheet; anything else opens that outlet''s own workflow. Non-''meta'' rows are only returned (RLS) to accounts with is_lab = true. Distinct from `outlets`, which is display-only pill labels. Lowercase letters/digits/underscore only.';

-- 3. Same shape as caller_account_is_beta() — self-contained, no reliance on
--    accounts' own RLS.
CREATE OR REPLACE FUNCTION public.caller_account_is_lab()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select exists (
    select 1 from accounts where user_id = auth.uid() and is_lab = true
  );
$$;

-- 4. Server-side enforcement: the existing policy plus the outlet rule.
DROP POLICY IF EXISTS campaign_templates_read ON campaign_templates;
CREATE POLICY campaign_templates_read ON campaign_templates
  FOR SELECT TO authenticated
  USING (
    status <> 'hidden'
    AND (visibility = 'public' OR public.caller_account_is_beta())
    AND (outlet = 'meta' OR public.caller_account_is_lab())
  );
-- Still no INSERT/UPDATE/DELETE policies: rows are edited by Will via Table
-- Editor / service role only. Edge functions (meta-campaign-create etc.) use
-- the service role and are unaffected.
