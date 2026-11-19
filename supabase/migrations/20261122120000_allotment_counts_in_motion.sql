-- Allotments count everything in the production line (owner, Nov 19 2026). A client's "used" this cycle is what was
-- asked this cycle (delivered or not) PLUS anything still moving through production whatever cycle it was asked in:
-- requested (briefed, not started), in production, in review, copy, with the client, in revisions. Before, an Asana
-- brief only counted once production started and work carried over from last cycle dropped out, so boards showed
-- "0/3 used, 3 in progress", flagged clients as behind pace and invited overproduction. Each piece counts once.
-- Same columns as before; asana_waiting_* is now the part of "used" briefed in Asana and not started yet.
create or replace view public.client_allotment_usage with (security_invoker = on) as
with cycle as (
  select c_1.id as client_id, allotment_period_start(c_1.billing_day::integer) as starts
  from clients c_1
), ours as (
  select r.client_id,
    sum(r.allotment_units) filter (where r.format = any (array['image'::creative_format, 'carousel'::creative_format])) as images,
    sum(r.allotment_units) filter (where r.format = 'video'::creative_format) as videos
  from requests r
    join cycle y_1 on y_1.client_id = r.client_id
    left join asana_tasks m on m.request_id = r.id
  where r.deleted_at is null
    and (
      case
        when m.counted_at is not null then m.counted_at >= y_1.starts
        else coalesce(m.asana_created_at, r.created_at) >= y_1.starts
      end
      -- still in the production line: it counts until it's delivered, whenever it was asked
      or r.stage <> all (array['ready_for_launch'::request_stage, 'launched'::request_stage])
    )
  group by r.client_id
), asana as (
  select t.client_id,
    sum(coalesce(t.new_images, case when t.format = any (array['image'::text, 'carousel'::text]) then 1 else 0 end)) filter (where t.counted_at >= y_1.starts or (t.open and coalesce(t.stage, 'requested'::text) = any (array['requested'::text, 'in_production'::text, 'internal_review'::text, 'copy'::text, 'copy_review'::text, 'ready_for_client'::text, 'client_review'::text, 'client_revision'::text]))) as images,
    sum(coalesce(t.new_videos, case when t.format = 'video'::text then 1 else 0 end)) filter (where t.counted_at >= y_1.starts or (t.open and coalesce(t.stage, 'requested'::text) = any (array['requested'::text, 'in_production'::text, 'internal_review'::text, 'copy'::text, 'copy_review'::text, 'ready_for_client'::text, 'client_review'::text, 'client_revision'::text]))) as videos,
    sum(coalesce(t.new_images, case when t.format = any (array['image'::text, 'carousel'::text]) then 1 else 0 end)) filter (where t.counted_at is null and t.open and t.stage = 'requested'::text) as waiting_images,
    sum(coalesce(t.new_videos, case when t.format = 'video'::text then 1 else 0 end)) filter (where t.counted_at is null and t.open and t.stage = 'requested'::text) as waiting_videos
  from asana_tasks t
    join cycle y_1 on y_1.client_id = t.client_id
  where t.request_id is null
  group by t.client_id
), progress as (
  select x.client_id, sum(x.images) as images, sum(x.videos) as videos
  from (
    select r.client_id,
      case when r.format = any (array['image'::creative_format, 'carousel'::creative_format]) then coalesce(r.allotment_units, 0) else 0 end as images,
      case when r.format = 'video'::creative_format then coalesce(r.allotment_units, 0) else 0 end as videos
    from requests r
    where r.deleted_at is null and (r.stage <> all (array['ready_for_launch'::request_stage, 'launched'::request_stage]))
    union all
    select t.client_id,
      coalesce(t.new_images, case when t.format = any (array['image'::text, 'carousel'::text]) then 1 else 0 end) as images,
      coalesce(t.new_videos, case when t.format = 'video'::text then 1 else 0 end) as videos
    from asana_tasks t
    where t.request_id is null and t.open and t.client_id is not null
      and (coalesce(t.stage, 'requested'::text) = any (array['requested'::text, 'in_production'::text, 'internal_review'::text, 'copy'::text, 'copy_review'::text, 'ready_for_client'::text, 'client_review'::text, 'client_revision'::text]))
  ) x
  group by x.client_id
)
select c.id as client_id,
  a.images_per_month,
  a.videos_per_month,
  (coalesce(o.images, 0::bigint) + coalesce(s.images, 0::bigint))::integer as images_used,
  (coalesce(o.videos, 0::bigint) + coalesce(s.videos, 0::bigint))::integer as videos_used,
  c.creative_package_until as package_until,
  coalesce(s.images, 0::bigint)::integer as asana_images,
  coalesce(s.videos, 0::bigint)::integer as asana_videos,
  coalesce(s.waiting_images, 0::bigint)::integer as asana_waiting_images,
  coalesce(s.waiting_videos, 0::bigint)::integer as asana_waiting_videos,
  c.billing_day,
  (y.starts at time zone 'America/New_York'::text)::date as period_start,
  ((y.starts at time zone 'America/New_York'::text)::date + '1 mon'::interval)::date as period_end,
  coalesce(g.images, 0::bigint)::integer as progress_images,
  coalesce(g.videos, 0::bigint)::integer as progress_videos
from clients c
  join cycle y on y.client_id = c.id
  left join client_allotments a on a.client_id = c.id
  left join ours o on o.client_id = c.id
  left join asana s on s.client_id = c.id
  left join progress g on g.client_id = c.id
where c.creative_package and c.archived_at is null
  and (c.creative_package_until is null or c.creative_package_until >= (now() at time zone 'America/New_York'::text)::date);

grant select on public.client_allotment_usage to authenticated;
