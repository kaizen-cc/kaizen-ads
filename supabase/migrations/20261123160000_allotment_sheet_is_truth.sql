-- Creative allotment usage, the owner's rule (Nov 23 2026):
--   DELIVERED comes from the client's Creative Database (the Google Sheet each client has): its "QTY of Total Creative
--   (including variations)" (every version counts), images and carousels vs video by Creative Type, by Date Created,
--   strictly inside the client's billing cycle (cycle start to reset). Work belongs to the cycle it was delivered in.
--   IN MOTION comes from Asana and Kaizen OS tickets: requested, in production, internal review or copy (not delivered
--   yet, so not in the sheet: nothing counts twice), whatever cycle it was asked in.
--   USED = delivered this cycle + in motion.
-- A client with no Creative Database read (none linked, or it couldn't be read) falls back to the briefed count as
-- before, marked usage_source 'briefs' so the card says so. A sheet can be linked or replaced by hand
-- (clients.creative_db_sheet_id) and read on demand from the allotment card.

alter table public.clients add column if not exists creative_db_sheet_id text;

create or replace view public.client_allotment_usage with (security_invoker = on) as
with members as (
  select c.id as client_id, coalesce(c.allotment_pool_id, c.id) as pool_id, allotment_period_start(coalesce(p.billing_day, c.billing_day)::integer) as starts, c.creative_db,
    (jsonb_typeof(c.creative_db -> 'rows') = 'array' and coalesce(c.creative_db ->> 'error', '') = '') as has_sheet
  from clients c
  left join clients p on p.id = c.allotment_pool_id
), ours as (
  select r.client_id,
    sum(r.allotment_units) filter (where r.format = any (array['image'::creative_format, 'carousel'::creative_format])) as images,
    sum(r.allotment_units) filter (where r.format = 'video'::creative_format) as videos
  from requests r
  join members y on y.client_id = r.client_id
  left join asana_tasks m on m.request_id = r.id
  where r.deleted_at is null and (
    case when m.counted_at is not null then m.counted_at >= y.starts else coalesce(m.asana_created_at, r.created_at) >= y.starts end
    or r.stage <> all (array['ready_for_launch'::request_stage, 'launched'::request_stage]))
  group by r.client_id
), asana as (
  select t.client_id,
    sum(coalesce(t.new_images, case when t.format = any (array['image', 'carousel']) then 1 else 0 end)) filter (where t.counted_at >= y.starts or t.open and coalesce(t.stage, 'requested') = any (array['requested', 'in_production', 'internal_review', 'copy', 'copy_review', 'ready_for_client', 'client_review', 'client_revision'])) as images,
    sum(coalesce(t.new_videos, case when t.format = 'video' then 1 else 0 end)) filter (where t.counted_at >= y.starts or t.open and coalesce(t.stage, 'requested') = any (array['requested', 'in_production', 'internal_review', 'copy', 'copy_review', 'ready_for_client', 'client_review', 'client_revision'])) as videos,
    sum(coalesce(t.new_images, case when t.format = any (array['image', 'carousel']) then 1 else 0 end)) filter (where t.counted_at is null and t.open and t.stage = 'requested') as waiting_images,
    sum(coalesce(t.new_videos, case when t.format = 'video' then 1 else 0 end)) filter (where t.counted_at is null and t.open and t.stage = 'requested') as waiting_videos
  from asana_tasks t
  join members y on y.client_id = t.client_id
  where t.request_id is null
  group by t.client_id
), progress as (
  -- In the production line, whatever cycle it was asked in. motion: not delivered yet (the sheet has none of it)
  select x.client_id, sum(x.images) as images, sum(x.videos) as videos, sum(x.images) filter (where x.motion) as motion_images, sum(x.videos) filter (where x.motion) as motion_videos
  from (
    select r.client_id,
      case when r.format = any (array['image'::creative_format, 'carousel'::creative_format]) then coalesce(r.allotment_units, 0) else 0 end as images,
      case when r.format = 'video'::creative_format then coalesce(r.allotment_units, 0) else 0 end as videos,
      r.stage = any (array['requested'::request_stage, 'in_production'::request_stage, 'internal_review'::request_stage, 'copy'::request_stage, 'copy_review'::request_stage]) as motion
    from requests r
    where r.deleted_at is null and r.stage <> all (array['ready_for_launch'::request_stage, 'launched'::request_stage])
    union all
    select t.client_id,
      coalesce(t.new_images, case when t.format = any (array['image', 'carousel']) then 1 else 0 end),
      coalesce(t.new_videos, case when t.format = 'video' then 1 else 0 end),
      coalesce(t.stage, 'requested') = any (array['requested', 'in_production', 'internal_review', 'copy', 'copy_review'])
    from asana_tasks t
    where t.request_id is null and t.open and t.client_id is not null
      and coalesce(t.stage, 'requested') = any (array['requested', 'in_production', 'internal_review', 'copy', 'copy_review', 'ready_for_client', 'client_review', 'client_revision'])
  ) x
  group by x.client_id
), delivered as (
  -- The Creative Database's rows dated inside the cycle: totals incl. variations
  select y.client_id,
    sum((r ->> 'a')::int) filter (where not coalesce((r ->> 'v')::boolean, false)) as images,
    sum((r ->> 'a')::int) filter (where coalesce((r ->> 'v')::boolean, false)) as videos
  from members y
  cross join lateral jsonb_array_elements(case when jsonb_typeof(y.creative_db -> 'rows') = 'array' then y.creative_db -> 'rows' else '[]'::jsonb end) r
  where (r ->> 'd')::date >= (y.starts at time zone 'America/New_York')::date
    and (r ->> 'd')::date < ((y.starts at time zone 'America/New_York')::date + interval '1 month')
  group by y.client_id
), per as (
  select y.client_id, y.pool_id, y.has_sheet,
    coalesce(o.images, 0) + coalesce(s.images, 0) as briefed_images,
    coalesce(o.videos, 0) + coalesce(s.videos, 0) as briefed_videos,
    coalesce(d.images, 0) as delivered_images,
    coalesce(d.videos, 0) as delivered_videos,
    coalesce(g.motion_images, 0) as motion_images,
    coalesce(g.motion_videos, 0) as motion_videos,
    -- With the sheet: delivered this cycle + in motion. Without: the briefed count, as before
    case when y.has_sheet then coalesce(d.images, 0) + coalesce(g.motion_images, 0) else coalesce(o.images, 0) + coalesce(s.images, 0) end as used_images,
    case when y.has_sheet then coalesce(d.videos, 0) + coalesce(g.motion_videos, 0) else coalesce(o.videos, 0) + coalesce(s.videos, 0) end as used_videos,
    case when y.has_sheet then coalesce(g.motion_images, 0) else coalesce(g.images, 0) end as progress_images,
    case when y.has_sheet then coalesce(g.motion_videos, 0) else coalesce(g.videos, 0) end as progress_videos,
    coalesce(s.images, 0) as asana_images, coalesce(s.videos, 0) as asana_videos,
    coalesce(s.waiting_images, 0) as waiting_images, coalesce(s.waiting_videos, 0) as waiting_videos
  from members y
  left join ours o on o.client_id = y.client_id
  left join asana s on s.client_id = y.client_id
  left join progress g on g.client_id = y.client_id
  left join delivered d on d.client_id = y.client_id
), pool as (
  select pool_id, sum(used_images) as used_images, sum(used_videos) as used_videos, sum(progress_images) as progress_images, sum(progress_videos) as progress_videos,
    sum(asana_images) as asana_images, sum(asana_videos) as asana_videos, sum(waiting_images) as waiting_images, sum(waiting_videos) as waiting_videos,
    sum(delivered_images) as delivered_images, sum(delivered_videos) as delivered_videos, sum(motion_images) as motion_images, sum(motion_videos) as motion_videos,
    count(*) as members, bool_and(has_sheet) as all_sheets
  from per
  group by pool_id
)
select c.id as client_id,
  case when coalesce(a.images_per_month, 0) = 0 and coalesce(a.videos_per_month, 0) = 0 then null else a.images_per_month end as images_per_month,
  case when coalesce(a.images_per_month, 0) = 0 and coalesce(a.videos_per_month, 0) = 0 then null else a.videos_per_month end as videos_per_month,
  coalesce(pl.used_images, 0)::integer as images_used,
  coalesce(pl.used_videos, 0)::integer as videos_used,
  c.creative_package_until as package_until,
  coalesce(pl.asana_images, 0)::integer as asana_images,
  coalesce(pl.asana_videos, 0)::integer as asana_videos,
  coalesce(pl.waiting_images, 0)::integer as asana_waiting_images,
  coalesce(pl.waiting_videos, 0)::integer as asana_waiting_videos,
  coalesce(root.billing_day, c.billing_day) as billing_day,
  (y.starts at time zone 'America/New_York')::date as period_start,
  ((y.starts at time zone 'America/New_York')::date + '1 mon'::interval)::date as period_end,
  coalesce(pl.progress_images, 0)::integer as progress_images,
  coalesce(pl.progress_videos, 0)::integer as progress_videos,
  y.pool_id as pool_client_id,
  (pl.members > 1) as shared_pool,
  pe.briefed_images::integer as briefed_images,
  pe.briefed_videos::integer as briefed_videos,
  coalesce(pl.delivered_images, 0)::integer as delivered_images,
  coalesce(pl.delivered_videos, 0)::integer as delivered_videos,
  not (coalesce(a.images_per_month, 0) = 0 and coalesce(a.videos_per_month, 0) = 0) as allotment_set,
  -- New: in motion (Asana and tickets, before delivery) and where used came from
  coalesce(pl.motion_images, 0)::integer as motion_images,
  coalesce(pl.motion_videos, 0)::integer as motion_videos,
  case when pl.all_sheets then 'sheet' else 'briefs' end as usage_source
from clients c
join members y on y.client_id = c.id
left join clients root on root.id = c.allotment_pool_id
left join client_allotments a on a.client_id = y.pool_id
left join pool pl on pl.pool_id = y.pool_id
left join per pe on pe.client_id = c.id
where c.creative_package
  and 'creative' = any (coalesce(c.services, '{}') || coalesce(c.services_extra, '{}'))
  and not ('creative' = any (coalesce(c.services_removed, '{}')))
  and not ('creative' = any (coalesce(c.strategy_only, '{}')))
  and c.archived_at is null
  and (c.creative_package_until is null or c.creative_package_until >= (now() at time zone 'America/New_York')::date);

grant select on public.client_allotment_usage to authenticated;
