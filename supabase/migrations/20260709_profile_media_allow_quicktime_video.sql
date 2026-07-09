-- Allow .mov (QuickTime) uploads for Boost ad creative — Meta creative is often
-- MP4 or MOV. Bucket already allows image/* + video/mp4; add video/quicktime.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime']
WHERE id = 'profile-media';
