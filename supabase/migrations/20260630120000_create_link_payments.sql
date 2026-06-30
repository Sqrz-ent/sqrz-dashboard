-- Per-payment record for payment-gated private links.
-- Written server-side by the Stripe webhook (service role); read by the
-- payments dashboard via admin client. RLS deferred (server-side only),
-- matching the pattern used for other new tables in this project.
create table if not exists public.link_payments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  link_id uuid references public.private_booking_links(id) on delete set null,
  profile_id uuid references public.profiles(id) on delete cascade,
  email text,
  amount numeric,
  currency text default 'eur',
  stripe_payment_intent text,
  stripe_session_id text unique,
  stripe_mode text default 'live'
);

create index if not exists link_payments_profile_id_idx on public.link_payments(profile_id);
create index if not exists link_payments_link_id_idx on public.link_payments(link_id);
