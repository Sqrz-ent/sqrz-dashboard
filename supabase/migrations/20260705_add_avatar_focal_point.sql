-- Focal point for the hero background (normalized 0..1). Nullable, no default:
-- null means fall back to the current "50% 0%" (center top) behavior for existing
-- profiles until the artist re-sets it.
ALTER TABLE profiles ADD COLUMN avatar_focal_x numeric;
ALTER TABLE profiles ADD COLUMN avatar_focal_y numeric;
