-- Asana's work counts against the creative allotment while the team moves over. Each mirrored task is read once (and
-- again when it's edited) for how many net-new images and videos it asks for for paid ads: a resize, iteration or
-- optimization of an existing ad draws nothing, nor does print (mailers, in-store signs). Tasks created this month
-- count once they're in production or past it (In Progress onward, Launched, or completed); a brief still in the
-- Creative Brief column doesn't yet. A migrated task counts as its ticket, in the month it was asked for in Asana.
alter table public.asana_tasks
  add column completed_at  timestamptz,
  add column new_images    int check (new_images >= 0),
  add column new_videos    int check (new_videos >= 0),
  add column units_note    text,
  add column units_key     text,
  add column units_read_at timestamptz;

create or replace view public.client_allotment_usage with (security_invoker = on) as
 WITH month AS (SELECT (date_trunc('month', (now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York') AS starts),
 ours AS (
   SELECT r.client_id,
     sum(r.new_count) FILTER (WHERE r.format = ANY (ARRAY['image'::public.creative_format, 'carousel'::public.creative_format])) AS images,
     sum(r.new_count) FILTER (WHERE r.format = 'video'::public.creative_format) AS videos
   FROM public.requests r
   LEFT JOIN public.asana_tasks m ON m.request_id = r.id
   WHERE r.deleted_at IS NULL AND COALESCE(m.asana_created_at, r.created_at) >= (SELECT starts FROM month)
   GROUP BY r.client_id),
 asana AS (
   SELECT t.client_id,
     sum(COALESCE(t.new_images, CASE WHEN t.format IN ('image', 'carousel') THEN 1 ELSE 0 END)) AS images,
     sum(COALESCE(t.new_videos, CASE WHEN t.format = 'video' THEN 1 ELSE 0 END)) AS videos
   FROM public.asana_tasks t
   WHERE t.request_id IS NULL AND t.client_id IS NOT NULL
     AND t.asana_created_at >= (SELECT starts FROM month)
     AND (t.completed_at IS NOT NULL OR (t.open AND t.stage IS DISTINCT FROM 'requested'))
   GROUP BY t.client_id)
 SELECT c.id AS client_id, a.images_per_month, a.videos_per_month,
    (COALESCE(o.images, 0) + COALESCE(s.images, 0))::integer AS images_used,
    (COALESCE(o.videos, 0) + COALESCE(s.videos, 0))::integer AS videos_used,
    c.creative_package_until AS package_until,
    COALESCE(s.images, 0)::integer AS asana_images,
    COALESCE(s.videos, 0)::integer AS asana_videos
   FROM public.clients c
     LEFT JOIN public.client_allotments a ON a.client_id = c.id
     LEFT JOIN ours o ON o.client_id = c.id
     LEFT JOIN asana s ON s.client_id = c.id
  WHERE c.creative_package AND c.archived_at IS NULL AND (c.creative_package_until IS NULL OR c.creative_package_until >= (now() AT TIME ZONE 'America/New_York')::date);
