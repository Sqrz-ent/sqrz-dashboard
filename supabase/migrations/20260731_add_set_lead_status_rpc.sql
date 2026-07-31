-- Swipe-to-archive/restore in Office (iOS) needs a write path for lead.status —
-- the leads table currently only grants SELECT to authenticated (see
-- 20260731_create_leads_drop_booking_proposals_wallets.sql; writes so far only
-- happen via service-role dashboard endpoints keyed on thread_id, which doesn't
-- cover web_form or future non-chat leads). Auth-scoped SECURITY DEFINER RPC,
-- same pattern as allocate_campaign_budget/set_campaign_budget_status — granted
-- directly to authenticated, called directly by iOS, no dashboard route involved.
-- Applied via apply_migration on 2026-07-31.
create or replace function public.set_lead_status(
  p_lead_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile_id uuid;
begin
  if p_status not in ('active','archived') then raise exception 'invalid status'; end if;
  select id into v_profile_id from profiles where user_id = auth.uid();
  if v_profile_id is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from leads where id = p_lead_id and profile_id = v_profile_id) then
    raise exception 'lead not found';
  end if;

  update leads set status = p_status where id = p_lead_id;
end;
$function$;

grant execute on function public.set_lead_status(uuid,text) to authenticated;
