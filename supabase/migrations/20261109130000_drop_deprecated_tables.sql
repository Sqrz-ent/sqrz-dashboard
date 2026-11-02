-- 2026-11-09 — Drop deprecated tables + profiles.plan_id. NOT APPLIED (written for review).
-- Based on docs/database/tables.md. Nothing is renamed; venues_toScrape and dedup_clusters are untouched.
--
-- DEPLOY ORDER (do these BEFORE applying this migration):
--   1. Deploy edge functions: apple-subscription-webhook (now reads campaign_templates.iap_product_id
--      instead of campaign_activation_products) and delete-account (no longer touches profile_references).
--   2. Deploy sqrz-dashboard (home loader no longer reads planName/refCode) and sqrz (profiles site no
--      longer selects plan_id — its select would 400 once the column is gone).
--   3. Old iOS builds are safe: Profile.planId was already optional (`Int?`) and no query lists plan_id.
--
-- DATA LOSS (intentional): profiles.plan_id is dropped — 3 profiles currently have plan_id = 1.
-- Table rows dropped: ad_spend_wallets_legacy (2), campaign_activation_products (2, both duplicated
-- in campaign_templates.iap_product_id), pending_signups (0), plans (2), profile_references (14),
-- city_fetch_requests (0).
--
-- NOT dropped on purpose: the ad_spend_wallets VIEW — sqrz-ios Features/Account/ExitAccountSheet.swift
-- still reads it. Switch that read to account_wallets first, then drop the view in a later migration.
--
-- Table drops use plain DROP TABLE (no CASCADE): if anything unexpected still depends on a table, the
-- whole migration fails and rolls back instead of silently dropping the dependent object.

begin;

-- ─── 1. Things that depend on profiles.plan_id ───────────────────────────────

-- 1a. HubSpot enrichment view: same as before minus plan_id. DROP + CREATE (removed column is not
-- trailing). Grants as before: service_role only (no anon/authenticated).
drop view if exists public.profile_hubspot_enrichment;

create view public.profile_hubspot_enrichment as
 select p.id,
    p.email,
    p.first_name,
    p.last_name,
    p.city,
    p.website_url,
    p.slug,
    p.created_at,
    p.company_name,
    p.custom_domain,
    p.hubspot_contact_id,
    p.company_name is not null and p.vat_id is not null as has_business_details,
    p.pixel_facebook is not null or p.pixel_google is not null or p.pixel_linkedin is not null as has_pixels,
    p.custom_domain is not null and p.custom_domain_verified = true as has_custom_domain,
    coalesce(svc.service_count, 0::bigint) as service_count,
    coalesce(pl.private_link_count, 0::bigint) as private_link_count
   from public.profiles p
     left join ( select profile_services.profile_id,
            count(*) as service_count
           from public.profile_services
          where profile_services.is_active = true
          group by profile_services.profile_id) svc on svc.profile_id = p.id
     left join ( select private_booking_links.profile_id,
            count(*) as private_link_count
           from public.private_booking_links
          where private_booking_links.is_active = true
          group by private_booking_links.profile_id) pl on pl.profile_id = p.id;

revoke all on public.profile_hubspot_enrichment from anon, authenticated;
grant all on public.profile_hubspot_enrichment to service_role;

-- 1b. HubSpot contact sync trigger listed plan_id in its UPDATE OF column list (a column-list trigger
-- depends on the column, so DROP COLUMN would otherwise fail). Same trigger minus plan_id.
drop trigger if exists on_profile_hubspot_sync on public.profiles;

create trigger on_profile_hubspot_sync
  after insert or update of email, first_name, last_name, city, website_url, slug, is_published
  on public.profiles
  for each row execute function public.trigger_hubspot_sync_contact();

-- 1c. get_dashboard_home: drop planName (read plans) and hasRefs (a constant false left over from
-- profile_references). Otherwise unchanged. Nothing reads either key (web home loader no longer
-- destructures planName/refCode; iOS does not call this RPC).
create or replace function public.get_dashboard_home(p_profile_id uuid default null::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
begin
  if p_profile_id is not null then
    if not user_owns_profile(p_profile_id) then
      raise exception 'not authorized';
    end if;
    v_profile_id := p_profile_id;
  else
    v_profile_id := get_profile_id_for_user(auth.uid());
  end if;

  return (
    select jsonb_build_object(
      'profile', to_jsonb(p),
      'hasServices',  exists(select 1 from profile_services  where profile_id = p.id),
      'hasVideos',    exists(select 1 from profile_videos    where profile_id = p.id)
    )
    from profiles p
    where p.id = v_profile_id
  );
end;
$function$;

-- ─── 2. handle_new_user without pending_signups ──────────────────────────────
-- Only change: the pending_signups slug lookup and the trailing DELETE FROM pending_signups are
-- removed. Everything else (existing-profile linking by email, slug from user metadata, generated
-- slug fallback, profile insert) is identical to the live function.
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
as $function$
DECLARE
  v_existing_profile_id UUID;
  v_slug TEXT;
  v_base_slug TEXT;
  v_candidate_slug TEXT;
  v_suffix INT := 0;
BEGIN
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
    v_slug := NULLIF(NEW.raw_user_meta_data->>'slug', '');

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

  RETURN NEW;
END;
$function$;

-- ─── 3. Drop profiles.plan_id (FK first, then the column) ────────────────────
alter table public.profiles drop constraint if exists profiles_plan_id_fkey;
alter table public.profiles drop column if exists plan_id;

-- ─── 4. Drop the deprecated tables (no CASCADE) ──────────────────────────────
drop table public.ad_spend_wallets_legacy;
drop table public.campaign_activation_products;
drop table public.pending_signups;
drop table public.plans;
drop table public.profile_references;
drop table public.city_fetch_requests;

commit;
