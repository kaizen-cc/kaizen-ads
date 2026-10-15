-- Kaizen Ads — comments can mark an area, not just a spot
-- A client (or the team) can drag a box around a whole area. x, y is then the box's top-left corner and w, h its size,
-- all 0-1 of the image. A plain pin has no w, h.
alter table public.review_comments
  add column w numeric check (w > 0 and w <= 1),
  add column h numeric check (h > 0 and h <= 1);
