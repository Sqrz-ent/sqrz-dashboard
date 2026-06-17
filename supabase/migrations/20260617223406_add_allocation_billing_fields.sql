alter table public.wallet_allocations
  add column if not exists billable_to_client boolean default false,
  add column if not exists show_amount boolean default true;

alter table public.booking_wallets
  add column if not exists invoice_mode text
  default 'consolidated'
  check (invoice_mode in ('consolidated', 'itemized'));
