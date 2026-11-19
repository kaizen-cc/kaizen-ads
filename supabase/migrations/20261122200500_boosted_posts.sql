-- Boosted posts (Head of Social, Nov 19 2026): which organic posts the ads team is putting money behind, and how much.
-- 1. meta_ad_posts: each recent ad's post, as Meta describes its creative (effective_object_story_id is the Facebook
--    post "<page>_<post>", effective_instagram_media_id the Instagram post), read for social clients' ads with spend.
-- 2. social_boosted_posts: the organic posts (social_posts) an ad runs, with the ads and their spend over the last 30
--    days (New York dates). A post an ad merely looks like (a dark post) never matches: only a published post does.

create table if not exists public.meta_ad_posts (
  ad_id         text primary key,
  client_id     uuid not null references public.clients(id) on delete cascade,
  ad_account_id text,
  ad_name       text,
  story_id      text,
  ig_media_id   text,
  checked_at    timestamptz not null default now()
);
create index if not exists meta_ad_posts_client on public.meta_ad_posts (client_id);
create index if not exists meta_ad_posts_story on public.meta_ad_posts (story_id) where story_id is not null;
create index if not exists meta_ad_posts_ig on public.meta_ad_posts (ig_media_id) where ig_media_id is not null;
alter table public.meta_ad_posts enable row level security;
drop policy if exists "staff read meta ad posts" on public.meta_ad_posts;
create policy "staff read meta ad posts" on public.meta_ad_posts for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));
grant select on public.meta_ad_posts to authenticated;

create or replace view public.social_boosted_posts with (security_invoker = on) as
with spend as (
  select d.ad_id, d.client_id,
    sum(coalesce((d.metrics ->> 'spend')::numeric, 0)) as spend,
    sum(coalesce((d.metrics ->> 'impressions')::numeric, 0)) as impressions,
    max(d.date) as last_day
  from public.meta_ad_daily d
  where d.date >= ((now() at time zone 'America/New_York')::date - 29)
  group by d.ad_id, d.client_id
)
select p.client_id, p.platform, p.post_id, p.permalink, p.caption, p.thumbnail_url, p.posted_at, p.format,
  count(distinct a.ad_id)::integer as ads,
  round(sum(s.spend), 2) as spend_30d,
  sum(s.impressions)::bigint as impressions_30d,
  max(s.last_day) as last_spend_day,
  array_agg(distinct a.ad_name) filter (where a.ad_name is not null) as ad_names
from public.meta_ad_posts a
join spend s on s.ad_id = a.ad_id
join public.social_posts p on p.client_id = a.client_id
  and ((p.platform = 'facebook' and p.post_id = a.story_id) or (p.platform = 'instagram' and p.post_id = a.ig_media_id))
group by p.client_id, p.platform, p.post_id, p.permalink, p.caption, p.thumbnail_url, p.posted_at, p.format
having sum(s.spend) > 0;

grant select on public.social_boosted_posts to authenticated;
