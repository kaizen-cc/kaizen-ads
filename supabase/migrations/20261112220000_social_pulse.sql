-- Social (the client page's Social tab, for organic social clients), read only. Each client's Facebook Page and
-- Instagram business account are found through Meta (the pages their ad account can promote, or the system user's
-- pages, matched by name) or picked by a person on the tab (source 'manual'); then the daily numbers and recent posts
-- are read with Kaizen's Meta system user (Page access tokens are fetched from it). Nothing here posts, edits or
-- schedules anything on Meta.
--
--   1. social_accounts: the Page and Instagram account linked to a client, how they were linked, and the last read's
--      result (including a missing permission, named, so the tab and Sync health say exactly what to add).
--   2. social_daily: per platform per day: followers, follows gained and lost, reach, views, profile views, accounts
--      engaged and interactions (a column stays null where Meta doesn't give that metric).
--   3. social_posts: the recent posts with their counts and, where Meta allows, their reach, saves, shares and views.
--
-- Additive and idempotent: safe to run more than once. The app works before it's applied (it shows nothing).
-- Staff read what they can see (private.staff_can_see_client); writes are the server's only (no write policies).

-- 1. The link
create table if not exists public.social_accounts (
  client_id        uuid primary key references public.clients (id) on delete cascade,
  page_id          text,
  page_name        text,
  ig_id            text,
  ig_username      text,
  -- auto: found by name through their ad account or the system user's pages · manual: picked on the tab
  source           text not null default 'auto' check (source in ('auto', 'manual')),
  -- active: reading · unlinked: no Page found yet (someone picks one) · failing: the last read failed
  status           text not null default 'active' check (status in ('active', 'unlinked', 'failing')),
  last_synced_at   timestamptz,
  backfilled_at    timestamptz,
  last_error       text,
  -- Meta permissions the last read was missing, e.g. {instagram_manage_insights}
  missing_permissions text[] not null default '{}',
  linked_by        uuid references public.profiles (id) on delete set null,
  updated_at       timestamptz not null default now()
);
alter table public.social_accounts enable row level security;
drop policy if exists "staff read social accounts" on public.social_accounts;
create policy "staff read social accounts" on public.social_accounts for select to authenticated using (private.staff_can_see_client(client_id));

-- 2. Daily numbers
create table if not exists public.social_daily (
  client_id        uuid not null references public.clients (id) on delete cascade,
  platform         text not null check (platform in ('instagram', 'facebook')),
  -- The Page or Instagram account the numbers are for: a client re-linked to another account keeps the old one's history
  account_id       text not null,
  date             date not null,
  followers        integer,
  follows_gained   integer,
  follows_lost     integer,
  reach            integer,
  views            integer,
  profile_views    integer,
  accounts_engaged integer,
  interactions     integer,
  updated_at       timestamptz not null default now(),
  primary key (client_id, platform, account_id, date)
);
alter table public.social_daily enable row level security;
drop policy if exists "staff read social daily" on public.social_daily;
create policy "staff read social daily" on public.social_daily for select to authenticated using (private.staff_can_see_client(client_id));

-- 3. Posts
create table if not exists public.social_posts (
  client_id     uuid not null references public.clients (id) on delete cascade,
  platform      text not null check (platform in ('instagram', 'facebook')),
  account_id    text not null,
  post_id       text not null,
  format        text,
  caption       text,
  permalink     text,
  thumbnail_url text,
  posted_at     timestamptz,
  likes         integer,
  comments      integer,
  shares        integer,
  saves         integer,
  reach         integer,
  views         integer,
  -- Likes, comments, shares and saves (Instagram's own total_interactions when it gives one)
  interactions  integer,
  -- Whether Meta gave this post's own insights (reach, saves, shares, views)
  insights_ok   boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (client_id, platform, post_id)
);
create index if not exists social_posts_client_posted on public.social_posts (client_id, posted_at desc);
alter table public.social_posts enable row level security;
drop policy if exists "staff read social posts" on public.social_posts;
create policy "staff read social posts" on public.social_posts for select to authenticated using (private.staff_can_see_client(client_id));

comment on table public.social_accounts is 'A client''s linked Facebook Page and Instagram business account for the Social tab; read only';
comment on table public.social_daily is 'Daily Facebook Page and Instagram account numbers from Meta''s insights; read only';
comment on table public.social_posts is 'Recent Facebook and Instagram posts with their counts and insights; read only';
