alter table public.profiles
  add column if not exists e_invoice_enabled boolean not null default false,
  add column if not exists e_invoice_unlocked_at timestamptz,
  add column if not exists e_invoice_unlock_source text;
