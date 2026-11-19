-- Social Media tiers, platforms and allotments (owner, Nov 19 2026). Social works like Email and Creative: its tier is
-- set in the Services panel (Team & setup), from the pricing deck (organic: Facebook and Instagram; TikTok and LinkedIn
-- as extras), Custom numbers, a Sprint (numbers until a day, then a tier or nothing) or Strategy only. Four pools a
-- billing cycle (allotment_period_start(billing_day)): posts, static graphics, video/reels and IG stories.
--
-- 1. social_packages: Basic, Silver, Gold, Platinum, and Custom (the client's own numbers in clients.social_custom).
-- 2. clients.social_package_key / social_custom / social_platforms / social_extra_videos: the tier, a custom or sprint
--    scope, the platforms the client posts on (null: the tier's own), added video/reels bought on top of a tier.
-- 3. social_stories: Instagram stories seen while live (the API only lists a story for its 24 hours; the social sync
--    runs every 3 hours, so each one is caught). Counted for the IG stories pool.
-- 4. client_social_allotment: each pool's cap this cycle and what's used. Used is what was published this cycle on the
--    platforms the client posts on (the most on any one platform: a post goes out on each of them), plus anything in the
--    production line (posts requested in Kaizen OS this cycle and not yet published).
-- 5. expire_sprint_packages() ends social sprints on their day too. Nothing is deleted.

create table if not exists public.social_packages (
  key            text primary key,
  label          text not null,
  posts          integer check (posts >= 0),
  statics        integer check (statics >= 0),
  videos         integer check (videos >= 0),
  stories        integer check (stories >= 0),
  platforms      text[] not null default '{facebook,instagram}',
  price_monthly  numeric,
  price_note     text,
  minimum_months integer,
  setup_fee      numeric,
  min_ad_spend   numeric,
  reports        text,
  includes       text,
  sort_order     integer not null default 0,
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);
alter table public.social_packages enable row level security;
drop policy if exists "staff read social packages" on public.social_packages;
create policy "staff read social packages" on public.social_packages for select to authenticated using ((select private.is_staff()));
grant select on public.social_packages to authenticated;

insert into public.social_packages (key, label, posts, statics, videos, stories, platforms, price_monthly, price_note, minimum_months, setup_fee, min_ad_spend, reports, includes, sort_order) values
  ('basic', 'Basic', 12, 12, 0, 0, '{facebook,instagram}', 600, '$600/mo', 2, null, null, 'Bi-weekly reports, monthly calendar', '12 posts, 12 static graphics a month on Facebook and Instagram', 1),
  ('silver', 'Silver', 16, 10, 2, 4, '{facebook,instagram}', 1000, '$1,000/mo', 2, null, null, 'Bi-weekly reports, monthly calendar', '16 posts, 10 statics, 2 video/reels, 4 IG stories a month; paid promotions; reach 5,000+ a month', 2),
  ('gold', 'Gold', 22, 10, 4, 8, '{facebook,instagram,tiktok}', 1500, '$1,500/mo', 3, null, null, 'Bi-weekly reports', '22 posts, 10 statics, 4 video/reels, 8 IG stories a month; paid promotions; real-time tracking; reach 10,000+ a month', 3),
  ('platinum', 'Platinum', 30, 12, 6, 12, '{facebook,instagram,tiktok,linkedin}', 2250, '$2,250/mo + ad spend', 3, 1500, 1000, 'Weekly reports, monthly calendar', '30 posts, 12 statics, 6 video/reels, 12 IG stories a month; paid promotions; A/B testing; CPA/ROAS', 4),
  ('custom', 'Custom', null, null, null, null, '{facebook,instagram}', null, null, null, null, null, null, 'This client''s own numbers, set on the client page', 9)
on conflict (key) do update set label = excluded.label, posts = excluded.posts, statics = excluded.statics, videos = excluded.videos, stories = excluded.stories,
  platforms = excluded.platforms, price_monthly = excluded.price_monthly, price_note = excluded.price_note, minimum_months = excluded.minimum_months,
  setup_fee = excluded.setup_fee, min_ad_spend = excluded.min_ad_spend, reports = excluded.reports, includes = excluded.includes, sort_order = excluded.sort_order, updated_at = now();

alter table public.clients add column if not exists social_package_key text references public.social_packages(key) on update cascade on delete set null;
alter table public.clients add column if not exists social_custom jsonb;
alter table public.clients add column if not exists social_platforms text[];
alter table public.clients add column if not exists social_extra_videos smallint not null default 0 check (social_extra_videos between 0 and 60);
alter table public.clients add column if not exists social_package_set_by uuid references public.profiles(id) on delete set null;
alter table public.clients add column if not exists social_package_set_at timestamptz;
comment on column public.clients.social_custom is 'Social Custom or Sprint scope: posts, statics, videos, stories (each with an optional _min for a range); a sprint adds sprint_until (YYYY-MM-DD) and after (the tier it rolls into, or null)';
comment on column public.clients.social_platforms is 'The platforms the client posts on (facebook, instagram, tiktok, linkedin, google_business); null: the tier''s own. Only these are read and scored';
comment on column public.clients.social_extra_videos is 'Added video/reels a month bought on top of the social tier ($150 each)';

-- Instagram stories, caught while live
create table if not exists public.social_stories (
  client_id   uuid not null references public.clients(id) on delete cascade,
  account_id  text not null,
  story_id    text not null,
  media_type  text,
  permalink   text,
  posted_at   timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (client_id, story_id)
);
create index if not exists social_stories_client_posted on public.social_stories (client_id, posted_at);
alter table public.social_stories enable row level security;
drop policy if exists "staff read social stories" on public.social_stories;
create policy "staff read social stories" on public.social_stories for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));
grant select on public.social_stories to authenticated;

create index if not exists social_posts_client_posted on public.social_posts (client_id, posted_at);

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
  -- Published this cycle, per platform the client posts on (only the linked accounts' rows)
  select y.client_id, sp.platform,
    count(*)::integer as posts,
    (count(*) filter (where sp.format in ('image', 'carousel')))::integer as statics,
    (count(*) filter (where sp.format in ('reel', 'video')))::integer as videos
  from cyc y
  join public.social_posts sp on sp.client_id = y.client_id and sp.platform = any (y.platforms) and sp.posted_at >= y.starts
  left join public.social_accounts a on a.client_id = y.client_id
  where (sp.platform = 'facebook' and sp.account_id = a.page_id)
     or (sp.platform = 'instagram' and sp.account_id = a.ig_id)
     or sp.platform not in ('facebook', 'instagram')
  group by y.client_id, sp.platform
), pub as (
  select client_id, max(posts) as posts, max(statics) as statics, max(videos) as videos from per group by client_id
), st as (
  select y.client_id, count(*)::integer as stories
  from cyc y
  join public.social_accounts a on a.client_id = y.client_id
  join public.social_stories s on s.client_id = y.client_id and s.account_id = a.ig_id and s.posted_at >= y.starts
  where 'instagram' = any (y.platforms)
  group by y.client_id
), req as (
  -- The production line: posts requested in Kaizen OS this cycle (an entry each in the social copy doc)
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

-- Sprints end on their day: creative, email and now social (to the tier picked, or no social allotment)
create or replace function public.expire_sprint_packages()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare n int; m int; s int;
begin
  update public.clients
  set creative_package = false
  where creative_package and creative_package_until is not null and creative_package_until < private.ny_today();
  get diagnostics n = row_count;

  update public.clients
  set email_package_key = nullif(email_custom ->> 'after', ''),
      email_custom = null,
      email_package_set_at = now()
  where email_package_key = 'custom'
    and email_custom ? 'sprint_until'
    and (email_custom ->> 'sprint_until') ~ '^\d{4}-\d{2}-\d{2}$'
    and (email_custom ->> 'sprint_until')::date < private.ny_today();
  get diagnostics m = row_count;

  update public.clients
  set social_package_key = nullif(social_custom ->> 'after', ''),
      social_custom = null,
      social_package_set_at = now()
  where social_package_key = 'custom'
    and social_custom ? 'sprint_until'
    and (social_custom ->> 'sprint_until') ~ '^\d{4}-\d{2}-\d{2}$'
    and (social_custom ->> 'sprint_until')::date < private.ny_today();
  get diagnostics s = row_count;
  return n + m + s;
end $function$;

revoke execute on function public.expire_sprint_packages() from public, anon, authenticated;
grant execute on function public.expire_sprint_packages() to service_role;
