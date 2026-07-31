-- No bookings, only leads. create_booking_request becomes lead-only (removes booking +
-- booking_participants creation entirely, keeps only the lead-insert logic shipped
-- last session). Then drop the now-fully-dead booking pipeline tables + their
-- booking-only trigger/RLS-helper functions. Signature kept 100% identical to the
-- live definition (all params, same defaults) so the public BookingModal call site
-- needs no RPC-call changes — only its result-handling changes (no more
-- booking_id/invite_token in the response).
-- Applied via apply_migration on 2026-07-31.

create or replace function public.create_booking_request(
  p_to_slug text, p_from_name text, p_from_email text,
  p_service text default null, p_title text default null, p_message text default null,
  p_event_date date default null, p_date_end date default null, p_event_location text default null,
  p_venue_address text default null, p_venue_city text default null, p_venue_zip text default null,
  p_venue_country text default null, p_phone text default null, p_booking_ref_code text default null,
  p_utm_source text default null, p_utm_medium text default null, p_utm_campaign text default null
)
returns json
language plpgsql
security definer
as $function$
declare
  v_to_profile_id     uuid;
  v_lead_id           uuid;
  v_boost_campaign_id uuid;
begin
  select id into v_to_profile_id from public.profiles where slug = p_to_slug;
  if v_to_profile_id is null then
    return json_build_object('error', 'Profile not found');
  end if;

  if p_utm_campaign is not null and p_utm_campaign like 'boost_%' then
    select id into v_boost_campaign_id
    from public.boost_campaigns
    where utm_campaign = p_utm_campaign and profile_id = v_to_profile_id
    limit 1;
  end if;

  -- Unused params (p_service, p_event_date, p_venue_*, p_phone, p_booking_ref_code,
  -- etc.) are kept in the signature for caller compatibility but no longer stored
  -- anywhere — there is no booking row for them to attach to.
  insert into public.leads (profile_id, name, email, message, source, status, campaign_id)
  values (v_to_profile_id, p_from_name, p_from_email, p_message, 'web_form', 'active', v_boost_campaign_id)
  returning id into v_lead_id;

  return json_build_object('success', true, 'lead_id', v_lead_id);
end;
$function$;

alter table public.profile_inquiry_threads drop column if exists converted_booking_id;

drop table if exists public.booking_channels;
drop table if exists public.messages;
drop table if exists public.booking_referral_earnings;
drop table if exists public.grow_clients;
drop table if exists public.invoices;
drop table if exists public.profile_delegates;
drop table if exists public.availability_blocks;
drop table if exists public.booking_participants cascade;
drop table if exists public.bookings cascade;

drop function if exists public.is_booking_owner(uuid);
drop function if exists public.is_booking_participant(uuid);
drop function if exists public.is_booking_admin(uuid);
drop function if exists public.update_booking_last_message();
drop function if exists public.enforce_booking_status_transition();
drop function if exists public.notify_booking_change();
drop function if exists public.add_requester_as_participant();
drop function if exists public.copy_lead_message_to_messages();
