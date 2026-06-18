-- Add 'release_requested' to the payout_status check constraint on booking_wallets.
-- This supports a payout flow where a member requests release of secured funds
-- before SQRZ marks them released.

ALTER TABLE public.booking_wallets
  DROP CONSTRAINT IF EXISTS booking_wallets_payout_status_check;

ALTER TABLE public.booking_wallets
  ADD CONSTRAINT booking_wallets_payout_status_check
  CHECK (payout_status IN (
    'pending',
    'approved',
    'release_requested',
    'released',
    'disputed'
  ));
