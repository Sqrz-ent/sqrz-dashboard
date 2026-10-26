-- campaign_templates.long_description (2026-10-26): the full product
-- explanation behind the card's "More info" button (iOS Grow tab). The
-- existing `description` stays the one-line teaser shown on the card.
alter table public.campaign_templates add column long_description text;
comment on column public.campaign_templates.long_description is
  'Full explanation of the product (how it works, what SQRZ does, what the artist provides, how billing works). Shown when the artist taps "More info" on the template card. Plain text; blank lines separate paragraphs. Null/empty = no More info button.';
