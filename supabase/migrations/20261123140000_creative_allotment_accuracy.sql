-- Creative allotments, made exact (owner, Nov 23 2026: "we REALLY need to make sure allotments are correct").
--
-- 1. Every version counts, as delivered. A brief's count is read from the brief (what was asked); production adds
--    variations. The client's Creative Database logs what was delivered, with "Total incl. variations". Used this cycle
--    is now the larger of: what was briefed (tickets and Asana tasks, as before), or what was delivered in the cycle
--    (the Creative Database's totals incl. variations, dated) plus what's still before delivery (requested, in
--    production, internal review, copy). Each piece counts once; the larger evidence wins.
-- 2. Strictly the billing cycle: the Creative Database rows are counted from the cycle's start (its dated rows, kept
--    on clients.creative_db.rows), never a calendar month or a rolling window.
-- 3. A location that draws from its parent's allotment (clients.allotment_pool_id) shares that pool: both show the
--    pool's cap, and the pool's use is every member's, counted in the pool owner's billing cycle.
-- 4. A 0/0 allotment is "not set", never "everything over": the cap reads null so nothing shows as over, and the Head
--    of Creative is told (src/lib/package-gaps.ts).

alter table public.clients add column if not exists allotment_pool_id uuid references public.clients(id) on delete set null;

-- Crust Pizza - Gleannloch Farms draws from Crust Pizza Co.'s corporate allotment ("Allocate some images from Corp
-- allotment to this location; no set package or count specified")
update public.clients set allotment_pool_id = '087579b7-a6f3-4a76-b3e5-37c6f16d0286' where id = '698273dd-b436-4996-8cce-023a39b1c455';

create or replace view public.client_allotment_usage with (security_invoker = on) as
with members as (
  -- Each client, the pool it counts in (its own, or its parent's) and that pool's billing cycle
  select c.id as client_id, coalesce(c.allotment_pool_id, c.id) as pool_id, allotment_period_start(coalesce(p.billing_day, c.billing_day)::integer) as starts, c.creative_db
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
  -- In the production line, whatever cycle it was asked in. pre: not delivered yet (the Creative Database has none of it)
  select x.client_id, sum(x.images) as images, sum(x.videos) as videos, sum(x.images) filter (where x.pre) as pre_images, sum(x.videos) filter (where x.pre) as pre_videos
  from (
    select r.client_id,
      case when r.format = any (array['image'::creative_format, 'carousel'::creative_format]) then coalesce(r.allotment_units, 0) else 0 end as images,
      case when r.format = 'video'::creative_format then coalesce(r.allotment_units, 0) else 0 end as videos,
      r.stage = any (array['requested'::request_stage, 'in_production'::request_stage, 'internal_review'::request_stage, 'copy'::request_stage, 'copy_review'::request_stage]) as pre
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
  -- The Creative Database's dated rows in the cycle: totals incl. variations (every version counts)
  select y.client_id,
    sum((r ->> 'a')::int) filter (where not coalesce((r ->> 'v')::boolean, false)) as images,
    sum((r ->> 'a')::int) filter (where coalesce((r ->> 'v')::boolean, false)) as videos
  from members y
  cross join lateral jsonb_array_elements(case when jsonb_typeof(y.creative_db -> 'rows') = 'array' then y.creative_db -> 'rows' else '[]'::jsonb end) r
  where (r ->> 'd')::date >= (y.starts at time zone 'America/New_York')::date
  group by y.client_id
), per as (
  -- Each client's own use: the larger of what was briefed, or what was delivered plus what's before delivery
  select y.client_id, y.pool_id,
    coalesce(o.images, 0) + coalesce(s.images, 0) as briefed_images,
    coalesce(o.videos, 0) + coalesce(s.videos, 0) as briefed_videos,
    coalesce(d.images, 0) as delivered_images,
    coalesce(d.videos, 0) as delivered_videos,
    greatest(coalesce(o.images, 0) + coalesce(s.images, 0), coalesce(d.images, 0) + coalesce(g.pre_images, 0)) as used_images,
    greatest(coalesce(o.videos, 0) + coalesce(s.videos, 0), coalesce(d.videos, 0) + coalesce(g.pre_videos, 0)) as used_videos,
    coalesce(g.images, 0) as progress_images,
    coalesce(g.videos, 0) as progress_videos,
    coalesce(s.images, 0) as asana_images, coalesce(s.videos, 0) as asana_videos,
    coalesce(s.waiting_images, 0) as waiting_images, coalesce(s.waiting_videos, 0) as waiting_videos
  from members y
  left join ours o on o.client_id = y.client_id
  left join asana s on s.client_id = y.client_id
  left join progress g on g.client_id = y.client_id
  left join delivered d on d.client_id = y.client_id
), pool as (
  select pool_id, sum(used_images) as used_images, sum(used_videos) as used_videos, sum(progress_images) as progress_images, sum(progress_videos) as progress_videos,
    sum(asana_images) as asana_images, sum(asana_videos) as asana_videos, sum(waiting_images) as waiting_images, sum(waiting_videos) as waiting_videos, count(*) as members
  from per
  group by pool_id
)
select c.id as client_id,
  -- 0/0 is "not set" (never everything over)
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
  -- New: the pool it counts in (another client when it draws from a parent's allotment), and this client's own evidence
  y.pool_id as pool_client_id,
  (pl.members > 1) as shared_pool,
  pe.briefed_images::integer as briefed_images,
  pe.briefed_videos::integer as briefed_videos,
  pe.delivered_images::integer as delivered_images,
  pe.delivered_videos::integer as delivered_videos,
  not (coalesce(a.images_per_month, 0) = 0 and coalesce(a.videos_per_month, 0) = 0) as allotment_set
from clients c
join members y on y.client_id = c.id
left join clients root on root.id = c.allotment_pool_id
-- The cap is the pool owner's
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
