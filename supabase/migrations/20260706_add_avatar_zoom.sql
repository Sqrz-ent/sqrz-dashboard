-- Hero image zoom, paired with avatar_focal_x/avatar_focal_y.
-- 1 = image scaled to exactly cover the frame (today's baseline); >1 = zoomed in.
-- Default 1 so existing profiles render identically (cover-fit, no extra zoom).
ALTER TABLE profiles ADD COLUMN avatar_zoom numeric DEFAULT 1;
