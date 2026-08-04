-- campaign-creative storage bucket had owner-scoped INSERT/DELETE/SELECT
-- policies but no UPDATE policy since its creation (the bucket + those three
-- policies were applied directly to the live DB, never committed — the same
-- "process gap" already flagged for other drift in root CLAUDE.md).
--
-- sqrz-ios's uploadCreative (BoostContentSheet) uses upsert: true, and
-- Supabase Storage's upsert performs a real UPDATE on storage.objects when an
-- object already exists at that path — so any second upload to the same
-- campaign (the sheet's "Replace" link, or re-picking a file) 42501'd with no
-- UPDATE policy to satisfy it.
--
-- Idempotent (drop-then-create): this exact policy was already applied
-- directly to the live DB ahead of this commit, same as the bucket's other
-- three policies were — this migration is what makes it tracked/reproducible
-- rather than a net-new change.
--
-- Verified against real RLS enforcement (rolled-back transaction, role
-- authenticated, auth.uid() set to a real profile owner): an UPDATE
-- simulating Storage's upsert-into-existing-object path failed before this
-- policy existed and succeeded with it in place.
drop policy if exists "campaign_creative_owner_update" on storage.objects;

create policy "campaign_creative_owner_update"
on storage.objects
for update
to public
using (
  bucket_id = 'campaign-creative'
  and (storage.foldername(name))[1] in (
    select profiles.id::text from profiles where profiles.user_id = auth.uid()
  )
)
with check (
  bucket_id = 'campaign-creative'
  and (storage.foldername(name))[1] in (
    select profiles.id::text from profiles where profiles.user_id = auth.uid()
  )
);
