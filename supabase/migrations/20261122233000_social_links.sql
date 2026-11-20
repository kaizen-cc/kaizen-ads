-- Many social accounts per client (Head of Social, Nov 19 2026): a client can have several Facebook Pages and Instagram
-- accounts, one per location (Mama Betty's Parmer and Burnett; McIntyres has four). social_accounts stays each client's
-- primary link (and its sync status); social_links holds every linked account with its location label. The primary is
-- kept in social_links by a trigger, so every reader can take the list from one place. A person's removal is kept as a
-- tombstone (removed_at), so the automatic matching never adds it back. Nothing is deleted.

create table if not exists public.social_links (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  platform    text not null check (platform in ('facebook', 'instagram')),
  account_id  text not null,
  name        text,
  location    text,
  -- Instagram: the Facebook Page it's attached to (its token reads it when the system user can't)
  page_id     text,
  source      text not null default 'manual' check (source in ('primary', 'auto', 'manual')),
  added_by    uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  uuid references public.profiles(id) on delete set null,
  unique (client_id, platform, account_id)
);
create index if not exists social_links_client on public.social_links (client_id) where removed_at is null;
alter table public.social_links enable row level security;
drop policy if exists "staff read social links" on public.social_links;
create policy "staff read social links" on public.social_links for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));
grant select on public.social_links to authenticated;

-- The primary link mirrored into social_links (a changed primary retires the old one unless a person added it)
create or replace function private.mirror_social_primary()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.page_id is not null and old.page_id is distinct from new.page_id then
      update public.social_links set removed_at = now(), updated_at = now()
      where client_id = new.client_id and platform = 'facebook' and account_id = old.page_id and source = 'primary' and removed_at is null;
    end if;
    if old.ig_id is not null and old.ig_id is distinct from new.ig_id then
      update public.social_links set removed_at = now(), updated_at = now()
      where client_id = new.client_id and platform = 'instagram' and account_id = old.ig_id and source = 'primary' and removed_at is null;
    end if;
  end if;
  if new.page_id is not null then
    insert into public.social_links (client_id, platform, account_id, name, source)
    values (new.client_id, 'facebook', new.page_id, new.page_name, 'primary')
    on conflict (client_id, platform, account_id) do update
      set name = coalesce(excluded.name, public.social_links.name), updated_at = now(),
          removed_at = case when public.social_links.source = 'primary' then null else public.social_links.removed_at end;
  end if;
  if new.ig_id is not null then
    insert into public.social_links (client_id, platform, account_id, name, page_id, source)
    values (new.client_id, 'instagram', new.ig_id, new.ig_username, new.page_id, 'primary')
    on conflict (client_id, platform, account_id) do update
      set name = coalesce(excluded.name, public.social_links.name), page_id = coalesce(public.social_links.page_id, excluded.page_id), updated_at = now(),
          removed_at = case when public.social_links.source = 'primary' then null else public.social_links.removed_at end;
  end if;
  return new;
end $$;

drop trigger if exists social_accounts_mirror on public.social_accounts;
create trigger social_accounts_mirror after insert or update of page_id, ig_id, page_name, ig_username on public.social_accounts
  for each row execute function private.mirror_social_primary();

-- Today's primaries into the list
insert into public.social_links (client_id, platform, account_id, name, source)
select client_id, 'facebook', page_id, page_name, 'primary' from public.social_accounts where page_id is not null
on conflict (client_id, platform, account_id) do nothing;
insert into public.social_links (client_id, platform, account_id, name, page_id, source)
select client_id, 'instagram', ig_id, ig_username, page_id, 'primary' from public.social_accounts where ig_id is not null
on conflict (client_id, platform, account_id) do nothing;

-- The allotment counts every linked account's posts (still the most on any one platform, now per account too)
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
  -- Published this cycle per linked account (only the client's linked accounts' rows); the allotment is per location,
  -- so the account that posted the most stands for the client
  select y.client_id, sp.platform, sp.account_id,
    count(*)::integer as posts,
    (count(*) filter (where sp.format in ('image', 'carousel')))::integer as statics,
    (count(*) filter (where sp.format in ('reel', 'video')))::integer as videos
  from cyc y
  join public.social_posts sp on sp.client_id = y.client_id and sp.platform = any (y.platforms) and sp.posted_at >= y.starts
  where sp.platform not in ('facebook', 'instagram')
     or exists (select 1 from public.social_links l where l.client_id = y.client_id and l.platform = sp.platform and l.account_id = sp.account_id and l.removed_at is null)
  group by y.client_id, sp.platform, sp.account_id
), pub as (
  select client_id, max(posts) as posts, max(statics) as statics, max(videos) as videos from per group by client_id
), st as (
  select y.client_id, max(n)::integer as stories
  from cyc y
  join lateral (
    select count(*) as n
    from public.social_stories s
    join public.social_links l on l.client_id = s.client_id and l.platform = 'instagram' and l.account_id = s.account_id and l.removed_at is null
    where s.client_id = y.client_id and s.posted_at >= y.starts
    group by s.account_id
  ) x on true
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
