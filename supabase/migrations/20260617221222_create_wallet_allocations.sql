create table public.wallet_allocations (
  id uuid primary key default gen_random_uuid(),
  wallet_id bigint references public.booking_wallets(id)
    on delete cascade not null,
  participant_id uuid references public.profiles(id)
    on delete set null,
  allocation_type text check (
    allocation_type in ('income','crew','promo','expense')
  ),
  label text,
  role text,
  amount numeric(10,2),
  currency text default 'EUR',
  status text default 'pending' check (
    status in ('pending','paid')
  ),
  stripe_payment_link_url text,
  stripe_session_id text,
  paid_at timestamptz,
  boost_campaign_id uuid references public.boost_campaigns(id)
    on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for wallet lookups
create index wallet_allocations_wallet_id_idx
  on public.wallet_allocations(wallet_id);

-- RLS
alter table public.wallet_allocations enable row level security;

-- Owner can read their own wallet allocations
create policy "Owner can read wallet allocations"
  on public.wallet_allocations for select
  using (
    exists (
      select 1 from public.booking_wallets bw
      where bw.id = wallet_allocations.wallet_id
        and bw.owner_profile_id = (
          select id from public.profiles
          where user_id = auth.uid()
          limit 1
        )
    )
  );

-- Owner can insert allocations
create policy "Owner can insert wallet allocations"
  on public.wallet_allocations for insert
  with check (
    exists (
      select 1 from public.booking_wallets bw
      where bw.id = wallet_allocations.wallet_id
        and bw.owner_profile_id = (
          select id from public.profiles
          where user_id = auth.uid()
          limit 1
        )
    )
  );

-- Owner can update allocations
create policy "Owner can update wallet allocations"
  on public.wallet_allocations for update
  using (
    exists (
      select 1 from public.booking_wallets bw
      where bw.id = wallet_allocations.wallet_id
        and bw.owner_profile_id = (
          select id from public.profiles
          where user_id = auth.uid()
          limit 1
        )
    )
  );
