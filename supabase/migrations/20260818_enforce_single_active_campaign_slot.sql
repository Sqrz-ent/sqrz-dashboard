-- Guardrail: an artist can only have one 'boost' campaign in review or live at
-- a time. Fires on the transition INTO in_review (booked->in_review AND the
-- needs_changes->in_review resubmit both match, since this only inspects
-- old/new status values, not the origin state — same pattern
-- on_boost_campaign_submit_meta_create's own WHEN clause already uses).
--
-- Deliberately scoped to campaign_type = 'boost' only — 'grow' rows are exempt
-- from boost_campaigns_status_check entirely (status is unconstrained free
-- text for grow, per hubspot-deal-stage-webhook's own comment), so there is no
-- single review/live vocabulary to enforce a slot against for grow.
--
-- Covers both write paths that can set status='in_review':
--   1. sqrz-ios's BoostContentSheet.submit() (the normal artist-facing path)
--   2. hubspot-deal-stage-webhook (admin drags a HubSpot deal card) — a
--      rejection here surfaces only in that function's own JSON response,
--      nothing writes back to the HubSpot deal. Flagged, not solved here.
create or replace function enforce_single_active_campaign_slot()
returns trigger as $$
begin
  if new.campaign_type = 'boost'
     and new.status = 'in_review'
     and old.status is distinct from 'in_review' then
    if exists (
      select 1 from boost_campaigns
      where profile_id = new.profile_id
        and id != new.id
        and campaign_type = 'boost'
        and status in ('in_review', 'live')
    ) then
      raise exception 'SLOT_OCCUPIED: You already have a campaign in review or live. Submit this one once it finishes.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_enforce_single_active_campaign_slot
  before update on boost_campaigns
  for each row
  execute function enforce_single_active_campaign_slot();
