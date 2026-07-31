-- Additive: create_booking_request now ALSO inserts a flat web_form lead so the
-- public booking form surfaces in the leads-based Office. The booking + participant
-- creation is unchanged; the only new thing is the leads row (thread_id null → each
-- submission is its own lead; nullable-unique allows many).
-- Applied via apply_migration on 2026-07-31. Only step 9 (the leads insert) is new.
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
  v_to_profile_id    uuid;
  v_booking_id       uuid;
  v_invite_token     text;
  v_existing_user_id uuid;
  v_referrer_id      uuid;
  v_ref_valid        boolean := false;
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

  if p_booking_ref_code is not null then
    select rc.owner_id into v_referrer_id
    from public.referral_codes rc
    where rc.code = p_booking_ref_code and rc.is_active = true and rc.is_partner = true;

    if v_referrer_id is not null then
      select exists (
        select 1 from public.referral_uses ru
        where ru.referral_code_id = (select id from public.referral_codes where code = p_booking_ref_code)
          and ru.referred_profile_id = v_to_profile_id and ru.converted = true
      ) into v_ref_valid;
    end if;

    if v_referrer_id = v_to_profile_id then
      v_ref_valid := false;
    end if;
  end if;

  v_invite_token := encode(gen_random_bytes(32), 'hex');

  insert into public.bookings (
    id, owner_id, title, service, status,
    city, date_start, date_end, description,
    venue_address, venue_city, venue_zip, venue_country,
    booking_ref_code, booking_ref_expires_at,
    utm_source, utm_medium, utm_campaign, boost_campaign_id
  ) values (
    gen_random_uuid(), v_to_profile_id,
    coalesce(p_title, p_service, 'Booking Request'), p_service, 'requested',
    p_event_location, p_event_date, p_date_end, p_message,
    p_venue_address, p_venue_city, p_venue_zip, p_venue_country,
    case when v_ref_valid then p_booking_ref_code else null end,
    case when v_ref_valid then now() + interval '60 days' else null end,
    p_utm_source, p_utm_medium, p_utm_campaign, v_boost_campaign_id
  )
  returning id into v_booking_id;

  insert into public.booking_participants (booking_id, user_id, name, email, is_admin, role)
  select v_booking_id, p.user_id, p.name, p.email, true, 'owner'
  from public.profiles p where p.id = v_to_profile_id;

  select user_id into v_existing_user_id
  from public.profiles where email = p_from_email and user_id is not null limit 1;

  insert into public.booking_participants (booking_id, user_id, name, email, is_admin, role, invite_token, phone)
  values (v_booking_id, v_existing_user_id, p_from_name, p_from_email, false, 'buyer', v_invite_token, p_phone);

  -- NEW (additive): also create a flat lead so this surfaces in the leads-based Office.
  insert into public.leads (profile_id, name, email, message, source, status, campaign_id)
  values (v_to_profile_id, p_from_name, p_from_email, p_message, 'web_form', 'active', v_boost_campaign_id);

  return json_build_object(
    'success', true, 'booking_id', v_booking_id, 'invite_token', v_invite_token
  );
end;
$function$;
