alter table public.booking_proposals
add column if not exists sqrz_fee_pct numeric;

update public.booking_proposals bp
set sqrz_fee_pct = coalesce(
  case
    when coalesce(bp.requires_payment, false) = false then 0
    else bw.sqrz_fee_pct
  end,
  case
    when coalesce(bp.requires_payment, false) = false then 0
    else pl.booking_fee_pct
  end,
  0
)
from public.bookings b
left join public.booking_wallets bw on bw.booking_id = bp.booking_id
left join public.profiles p on p.id = b.owner_id
left join public.plans pl on pl.id = p.plan_id
where bp.booking_id = b.id
  and bp.sqrz_fee_pct is null;
