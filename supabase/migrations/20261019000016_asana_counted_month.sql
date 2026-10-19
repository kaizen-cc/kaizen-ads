-- Asana work counts in the month it's actually worked on: each task gets its allotment month once, when it's first
-- seen in production or delivered (delivered: the month it was completed; in production: the month it last changed).
-- It never moves after that, so a task counts in exactly one month. A brief still in the Creative Brief column doesn't
-- count yet; it shows as briefed and waiting, so nobody requests past what's spoken for. A migrated task counts as its
-- ticket, in its Asana month. Kaizen Ads' own tickets count when they're requested, as before.
alter table public.asana_tasks add column counted_month date;

create or replace view public.client_allotment_usage with (security_invoker = on) as
 WITH month AS (SELECT (date_trunc('month', (now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York') AS starts,
                       date_trunc('month', (now() AT TIME ZONE 'America/New_York'))::date AS day),
 ours AS (
   SELECT r.client_id,
     sum(r.new_count) FILTER (WHERE r.format = ANY (ARRAY['image'::public.creative_format, 'carousel'::public.creative_format])) AS images,
     sum(r.new_count) FILTER (WHERE r.format = 'video'::public.creative_format) AS videos
   FROM public.requests r
   LEFT JOIN public.asana_tasks m ON m.request_id = r.id
   WHERE r.deleted_at IS NULL
     AND CASE WHEN m.counted_month IS NOT NULL THEN m.counted_month = (SELECT day FROM month)
              ELSE COALESCE(m.asana_created_at, r.created_at) >= (SELECT starts FROM month) END
   GROUP BY r.client_id),
 asana AS (
   SELECT t.client_id,
     sum(COALESCE(t.new_images, CASE WHEN t.format IN ('image', 'carousel') THEN 1 ELSE 0 END)) FILTER (WHERE t.counted_month = (SELECT day FROM month)) AS images,
     sum(COALESCE(t.new_videos, CASE WHEN t.format = 'video' THEN 1 ELSE 0 END)) FILTER (WHERE t.counted_month = (SELECT day FROM month)) AS videos,
     sum(COALESCE(t.new_images, CASE WHEN t.format IN ('image', 'carousel') THEN 1 ELSE 0 END)) FILTER (WHERE t.counted_month IS NULL AND t.open AND t.stage = 'requested') AS waiting_images,
     sum(COALESCE(t.new_videos, CASE WHEN t.format = 'video' THEN 1 ELSE 0 END)) FILTER (WHERE t.counted_month IS NULL AND t.open AND t.stage = 'requested') AS waiting_videos
   FROM public.asana_tasks t
   WHERE t.request_id IS NULL AND t.client_id IS NOT NULL
   GROUP BY t.client_id)
 SELECT c.id AS client_id, a.images_per_month, a.videos_per_month,
    (COALESCE(o.images, 0) + COALESCE(s.images, 0))::integer AS images_used,
    (COALESCE(o.videos, 0) + COALESCE(s.videos, 0))::integer AS videos_used,
    c.creative_package_until AS package_until,
    COALESCE(s.images, 0)::integer AS asana_images,
    COALESCE(s.videos, 0)::integer AS asana_videos,
    COALESCE(s.waiting_images, 0)::integer AS asana_waiting_images,
    COALESCE(s.waiting_videos, 0)::integer AS asana_waiting_videos
   FROM public.clients c
     LEFT JOIN public.client_allotments a ON a.client_id = c.id
     LEFT JOIN ours o ON o.client_id = c.id
     LEFT JOIN asana s ON s.client_id = c.id
  WHERE c.creative_package AND c.archived_at IS NULL AND (c.creative_package_until IS NULL OR c.creative_package_until >= (now() AT TIME ZONE 'America/New_York')::date);
