-- Social locations (owner, Nov 19 2026): each linked account's own status, and the allotment counting every location.
-- 1. social_links.last_read_at / last_error: when each Page or Instagram account was last read, and why its last read
--    failed (Kaizen's Meta access can't reach it), so the Social connections card shows each one's state.
-- 2. client_social_allotment: posts across every location count against the package (a Page per location adds up), still
--    the most on any one platform (a post goes out on Facebook and Instagram alike); IG stories across every account.

alter table public.social_links add column if not exists last_read_at timestamptz;
alter table public.social_links add column if not exists last_error text;

create or replace view public.client_social_allotment with (security_invoker = on) as
with cyc as (
  select c.id as client_id, allotment_period_start(c.billing_day::integer) as starts, c.social_custom,
    coalesce(c.social_extra_videos, 0)::integer as extra_videos,
    'social-media' = any (c.strategy_only) as strategy,
    p.key as package_key, p.label as package_label, p.posts as p_posts, p.statics as p_statics, p.videos as p_videos, p.stories as p_stories,
    p.platforms as tier_platforms,
    coalesce(c.social_platforms, p.platforms, array['facebook', 'instagram']) as platforms
  from public.clients c
  left join public.social_packages p on p.key = c.social_package_key and p.active
  where c.archived_at is null
), cap as (
  select y.*,
    y.package_key = 'custom' and coalesce(y.social_custom ->> 'sprint_until', '') <> '' as sprint,
    case when y.strategy then null when y.package_key = 'custom' then (y.social_custom ->> 'posts')::integer else y.p_posts end as posts_max,
    case when y.strategy then null when y.package_key = 'custom' then coalesce((y.social_custom ->> 'posts_min')::integer, (y.social_custom ->> 'posts')::integer) else y.p_posts end as posts_lo,
    case when y.strategy then null when y.package_key = 'custom' then (y.social_custom ->> 'statics')::integer else y.p_statics end as statics_max,
    case when y.strategy then null when y.package_key = 'custom' then coalesce((y.social_custom ->> 'statics_min')::integer, (y.social_custom ->> 'statics')::integer) else y.p_statics end as statics_lo,
    case when y.strategy then null when y.package_key = 'custom' then (y.social_custom ->> 'videos')::integer when y.package_key is null then null else y.p_videos + y.extra_videos end as videos_max,
    case when y.strategy then null when y.package_key = 'custom' then coalesce((y.social_custom ->> 'videos_min')::integer, (y.social_custom ->> 'videos')::integer) when y.package_key is null then null else y.p_videos + y.extra_videos end as videos_lo,
    case when y.strategy then null when y.package_key = 'custom' then (y.social_custom ->> 'stories')::integer else y.p_stories end as stories_max,
    case when y.strategy then null when y.package_key = 'custom' then coalesce((y.social_custom ->> 'stories_min')::integer, (y.social_custom ->> 'stories')::integer) else y.p_stories end as stories_lo
  from cyc y
), per as (
  -- Published this cycle per platform, every linked location's account added up
  select y.client_id, sp.platform,
    count(*)::integer as posts,
    (count(*) filter (where sp.format in ('image', 'carousel')))::integer as statics,
    (count(*) filter (where sp.format in ('reel', 'video')))::integer as videos
  from cyc y
  join public.social_posts sp on sp.client_id = y.client_id and sp.platform = any (y.platforms) and sp.posted_at >= y.starts
  where sp.platform not in ('facebook', 'instagram')
     or exists (select 1 from public.social_links l where l.client_id = y.client_id and l.platform = sp.platform and l.account_id = sp.account_id and l.removed_at is null)
  group by y.client_id, sp.platform
), pub as (
  select client_id, max(posts) as posts, max(statics) as statics, max(videos) as videos from per group by client_id
), st as (
  select y.client_id, count(*)::integer as stories
  from cyc y
  join public.social_stories s on s.client_id = y.client_id and s.posted_at >= y.starts
  join public.social_links l on l.client_id = s.client_id and l.platform = 'instagram' and l.account_id = s.account_id and l.removed_at is null
  where 'instagram' = any (y.platforms)
  group by y.client_id
), req as (
  select y.client_id, sum(jsonb_array_length(case when jsonb_typeof(d.content -> 'emails') = 'array' then d.content -> 'emails' else '[]'::jsonb end))::integer as posts
  from cyc y
  join public.copy_docs d on d.client_id = y.client_id and d.kind = 'social' and d.status = 'requested' and d.updated_at >= y.starts
  group by y.client_id
)
select a.client_id,
  a.posts_lo as posts_min, a.posts_max as posts_per_month,
  a.statics_lo as statics_min, a.statics_max as statics_per_month,
  a.videos_lo as videos_min, a.videos_max as videos_per_month,
  a.stories_lo as stories_min, a.stories_max as stories_per_month,
  case when a.strategy then 'strategy' when a.sprint then 'sprint' when a.package_key = 'custom' then 'custom' when a.package_key is not null then 'package' else null end as cap_source,
  a.package_key, a.package_label,
  case when a.sprint then a.social_custom ->> 'sprint_until' else null end as sprint_until,
  case when a.sprint then nullif(a.social_custom ->> 'after', '') else null end as sprint_after,
  a.extra_videos,
  a.platforms, a.tier_platforms,
  greatest(coalesce(p.posts, 0), coalesce(r.posts, 0)) as posts_used,
  coalesce(p.statics, 0) as statics_used,
  coalesce(p.videos, 0) as videos_used,
  coalesce(s.stories, 0) as stories_used,
  greatest(0, coalesce(r.posts, 0) - coalesce(p.posts, 0)) as posts_progress,
  coalesce(p.posts, 0) as posts_done,
  coalesce(p.statics, 0) as statics_done,
  coalesce(p.videos, 0) as videos_done,
  coalesce(s.stories, 0) as stories_done,
  (a.starts at time zone 'America/New_York')::date as period_start,
  ((a.starts at time zone 'America/New_York')::date + interval '1 month')::date as period_end
from cap a
left join pub p on p.client_id = a.client_id
left join st s on s.client_id = a.client_id
left join req r on r.client_id = a.client_id;

grant select on public.client_social_allotment to authenticated;
