-- Store the original proposal rate (seller net) frozen at wallet creation.
-- Allocations (e.g. added income lines) mutate secured_amount over time, so we
-- keep base_rate as the immutable starting point for recompute logic.

ALTER TABLE public.booking_wallets
  ADD COLUMN IF NOT EXISTS base_rate numeric(10,2);

-- Backfill existing rows: for wallets created before this column existed (and
-- therefore with no allocation-driven adjustments), secured_amount IS the base rate.
UPDATE public.booking_wallets
SET base_rate = secured_amount
WHERE base_rate IS NULL;
