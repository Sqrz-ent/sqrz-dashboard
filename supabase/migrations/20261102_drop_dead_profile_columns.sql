-- Apply only after the iOS build without Profile.is_beta is installed by all testers.
--
-- Drops 12 profiles columns confirmed dead across all four SQRZ repos by the
-- 2026-11-01 audit (docs/cleanup/profiles-columns.md): stripe_connect_id,
-- stripe_connect_id_test, stripe_connect_status, stripe_connect_status_test,
-- claim_token, claimed_at, is_claimed, is_beta, is_demo, onboarding_completed,
-- availability_status, show_gig_history, grow_qualified.
--
-- Explicitly KEPT (do not touch): stripe_beta_test_mode (live Stripe
-- test/live switch for wallet top-up + campaign budget checkout),
-- is_partner (gates get-or-create-invite-code + iOS UI),
-- stripe_customer_id / stripe_customer_id_test (budget payments).
-- accounts.is_beta is a separate column/table and is untouched by this file.
--
-- claim_token/is_claimed/grow_qualified are structurally wired into
-- handle_new_user() and two triggers — those are rewritten/dropped first,
-- then the columns, then the one dependent view. Order matters: a bare
-- DROP COLUMN does not touch trigger function bodies (see root CLAUDE.md's
-- "Known Open Issues" for the exact class of incident this avoids).

-- ─── 1. Rewrite handle_new_user(): drop the claim_token-matching branch and
-- the is_claimed references. The email-fallback match (step 2) keeps working
-- for pre-seeded profiles with no user_id yet, just without the
-- is_claimed = false filter (the column no longer exists) and without
-- setting is_claimed = true on claim. ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_existing_profile_id UUID;
  v_slug TEXT;
  v_base_slug TEXT;
  v_candidate_slug TEXT;
  v_suffix INT := 0;
  v_pending_slug TEXT;
BEGIN
  -- Match an existing pre-seeded profile (no user_id yet) by email.
  -- The claim_token-based matching branch (previously checked first) was
  -- removed here along with claim_token/claimed_at/is_claimed — no client
  -- has been able to produce a signup carrying claim_token metadata since
  -- sqrz-dashboard's /claim route was deleted 2026-08-08.
  SELECT id INTO v_existing_profile_id
  FROM public.profiles
  WHERE email = NEW.email
    AND user_id IS NULL
  LIMIT 1;

  IF v_existing_profile_id IS NOT NULL THEN
    UPDATE public.profiles
    SET user_id = NEW.id,
        email = COALESCE(email, NEW.email),
        updated_at = now()
    WHERE id = v_existing_profile_id;
  ELSE
    -- slug from signup options.data, if the client ever sends it
    v_slug := NULLIF(NEW.raw_user_meta_data->>'slug', '');

    -- fall back to a slug reserved by the join flow (device-independent)
    IF v_slug IS NULL THEN
      SELECT slug INTO v_pending_slug
      FROM public.pending_signups
      WHERE email = NEW.email
      ORDER BY created_at DESC
      LIMIT 1;

      IF v_pending_slug IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE slug = v_pending_slug) THEN
        v_slug := v_pending_slug;
      END IF;
    END IF;

    -- last resort: derive from email local-part, sanitized, deduped
    IF v_slug IS NULL THEN
      v_base_slug := lower(regexp_replace(split_part(COALESCE(NEW.email, ''), '@', 1), '[^a-zA-Z0-9]', '', 'g'));
      IF v_base_slug IS NULL OR v_base_slug = '' THEN
        v_base_slug := 'user';
      END IF;

      v_candidate_slug := v_base_slug;
      WHILE EXISTS (SELECT 1 FROM public.profiles WHERE slug = v_candidate_slug) LOOP
        v_suffix := v_suffix + 1;
        v_candidate_slug := v_base_slug || v_suffix::text;
      END LOOP;

      v_slug := v_candidate_slug;
    END IF;

    INSERT INTO public.profiles (id, user_id, email, slug, user_type)
    VALUES (gen_random_uuid(), NEW.id, NEW.email, v_slug, 'member');
  END IF;

  -- Consume/clear any reservation for this email regardless of which path was taken
  DELETE FROM public.pending_signups WHERE email = NEW.email;

  RETURN NEW;
END;
$function$;

-- ─── 2. Drop the claim_token/grow_qualified triggers and their functions ──
DROP TRIGGER IF EXISTS set_claim_token ON public.profiles;
DROP TRIGGER IF EXISTS on_claim_token_set ON public.profiles;

DROP FUNCTION IF EXISTS public.generate_claim_token_for_trigger();
DROP FUNCTION IF EXISTS public.auto_qualify_seeded_profile();

-- Both already-orphaned generate_claim_token overloads (neither was ever
-- attached as a trigger, and public.generate_claim_token(text) has zero
-- callers anywhere in the codebase per the audit) go too.
DROP FUNCTION IF EXISTS public.generate_claim_token();
DROP FUNCTION IF EXISTS public.generate_claim_token(text);

-- ─── 3. Recreate profile_hubspot_enrichment without the dropped columns ───
-- (stripe_connect_status, onboarding_completed, grow_qualified, and the
-- stripe_connected column derived from stripe_connect_status). DROP + CREATE
-- rather than CREATE OR REPLACE since the removed columns aren't trailing.
DROP VIEW IF EXISTS public.profile_hubspot_enrichment;

CREATE VIEW public.profile_hubspot_enrichment AS
 SELECT p.id,
    p.email,
    p.first_name,
    p.last_name,
    p.city,
    p.website_url,
    p.slug,
    p.plan_id,
    p.created_at,
    p.company_name,
    p.custom_domain,
    p.hubspot_contact_id,
    ((p.company_name IS NOT NULL) AND (p.vat_id IS NOT NULL)) AS has_business_details,
    ((p.pixel_facebook IS NOT NULL) OR (p.pixel_google IS NOT NULL) OR (p.pixel_linkedin IS NOT NULL)) AS has_pixels,
    ((p.custom_domain IS NOT NULL) AND (p.custom_domain_verified = true)) AS has_custom_domain,
    COALESCE(svc.service_count, (0)::bigint) AS service_count,
    COALESCE(pl.private_link_count, (0)::bigint) AS private_link_count
   FROM ((public.profiles p
     LEFT JOIN ( SELECT profile_services.profile_id,
            count(*) AS service_count
           FROM public.profile_services
          WHERE (profile_services.is_active = true)
          GROUP BY profile_services.profile_id) svc ON ((svc.profile_id = p.id)))
     LEFT JOIN ( SELECT private_booking_links.profile_id,
            count(*) AS private_link_count
           FROM public.private_booking_links
          WHERE (private_booking_links.is_active = true)
          GROUP BY private_booking_links.profile_id) pl ON ((pl.profile_id = p.id)));

-- ─── 4. Drop the 12 dead columns. Indexes that depend solely on a dropped
-- column (profiles_claim_token_key, profiles_claim_token_idx,
-- profiles_is_claimed_idx) are dropped automatically with their column —
-- no explicit DROP INDEX needed. ───────────────────────────────────────────
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS stripe_connect_id,
  DROP COLUMN IF EXISTS stripe_connect_id_test,
  DROP COLUMN IF EXISTS stripe_connect_status,
  DROP COLUMN IF EXISTS stripe_connect_status_test,
  DROP COLUMN IF EXISTS claim_token,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS is_claimed,
  DROP COLUMN IF EXISTS is_beta,
  DROP COLUMN IF EXISTS is_demo,
  DROP COLUMN IF EXISTS onboarding_completed,
  DROP COLUMN IF EXISTS availability_status,
  DROP COLUMN IF EXISTS show_gig_history,
  DROP COLUMN IF EXISTS grow_qualified;
