-- YouTube learning (an exec's ask, Nov 20 2026): the agents keep studying a set of YouTube channels (media-buying
-- styles, strategies, what works, general marketing methods) and single videos, set up in one place: Settings › AI
-- agents › YouTube. Execs and line heads subscribe; the context cron (?step=youtube) finds new uploads, reads each
-- video's transcript and turns it into attributed takeaways, each tagged with its lines and the roles it matters to.
-- Everyone each takeaway involves hears about it in the app (one notice per person per day); a line head or an exec
-- accepts it into the agents' learning (agent_learnings, active only once accepted), calls in an agent to work it into
-- the playbook, or dismisses it.
--
-- 1. youtube_sources: a channel (or a single video) and the lines it teaches.
-- 2. youtube_videos: one row per YouTube video, ever (its transcript, status, summary).
-- 3. youtube_takeaways: what each video teaches, its lines and roles, the decision on it.
-- 4. claim_youtube_video(): the worker claims the next due video (skip locked, so parallel runs never collide).
-- Reads: every staff member (the takeaways are shared with the whole team). Writes go through the server.

create table if not exists public.youtube_sources (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'channel' check (kind in ('channel', 'video')),
  url             text not null,
  handle          text,
  channel_id      text,
  title           text,
  thumbnail_url   text,
  about           text,
  -- The lines it teaches: meta (Meta and TikTok ads), google, creative, email, social; 'all' for every line
  lines           text[] not null default '{}',
  -- The lines the AI suggested from the channel's videos (the exec or head edits lines; this stays as the hint)
  suggested_lines text[] not null default '{}',
  active          boolean not null default true,
  last_checked_at timestamptz,
  error           text,
  video_count     integer not null default 0,
  added_by        uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists youtube_sources_channel on public.youtube_sources (channel_id) where kind = 'channel' and channel_id is not null;
create index if not exists youtube_sources_due on public.youtube_sources (last_checked_at nulls first) where active;

create table if not exists public.youtube_videos (
  id                uuid primary key default gen_random_uuid(),
  video_id          text not null unique,
  source_id         uuid references public.youtube_sources(id) on delete set null,
  url               text not null,
  title             text,
  channel_title     text,
  description       text,
  thumbnail_url     text,
  published_at      timestamptz,
  transcript        text,
  -- queued → reading → done | no_transcript | skipped | failed
  status            text not null default 'queued' check (status in ('queued', 'reading', 'done', 'no_transcript', 'skipped', 'failed')),
  summary           text,
  error             text,
  attempts          integer not null default 0,
  next_at           timestamptz not null default now(),
  -- Asked for by someone (a pasted link, "summarize this video"): never shared with the team unless it's a source's
  on_demand         boolean not null default false,
  shared_at         timestamptz,
  added_by          uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists youtube_videos_source on public.youtube_videos (source_id, published_at desc);
create index if not exists youtube_videos_due on public.youtube_videos (next_at) where status = 'queued';
create index if not exists youtube_videos_unshared on public.youtube_videos (created_at) where status = 'done' and shared_at is null;

create table if not exists public.youtube_takeaways (
  id            uuid primary key default gen_random_uuid(),
  video_row     uuid not null references public.youtube_videos(id) on delete cascade,
  takeaway      text not null,
  why           text,
  lines         text[] not null default '{}',
  roles         text[] not null default '{}',
  at_seconds    integer,
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'called', 'dismissed')),
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  learning_ids  uuid[] not null default '{}',
  called_role   text,
  created_at    timestamptz not null default now()
);
create index if not exists youtube_takeaways_video on public.youtube_takeaways (video_row);
create index if not exists youtube_takeaways_pending on public.youtube_takeaways (created_at desc) where status = 'pending';

alter table public.youtube_sources enable row level security;
alter table public.youtube_videos enable row level security;
alter table public.youtube_takeaways enable row level security;
drop policy if exists "staff read youtube sources" on public.youtube_sources;
create policy "staff read youtube sources" on public.youtube_sources for select to authenticated using ((select private.is_staff()));
drop policy if exists "staff read youtube videos" on public.youtube_videos;
create policy "staff read youtube videos" on public.youtube_videos for select to authenticated using ((select private.is_staff()));
drop policy if exists "staff read youtube takeaways" on public.youtube_takeaways;
create policy "staff read youtube takeaways" on public.youtube_takeaways for select to authenticated using ((select private.is_staff()));
grant select on public.youtube_sources, public.youtube_videos, public.youtube_takeaways to authenticated;

-- The worker claims the next due video (a reading one stuck for 20 minutes counts as due again)
create or replace function public.claim_youtube_video()
returns setof public.youtube_videos language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.youtube_videos v set status = 'reading', attempts = v.attempts + 1, updated_at = now()
   where v.id = (
     select id from public.youtube_videos
      where (status = 'queued' and next_at <= now()) or (status = 'reading' and updated_at < now() - interval '20 minutes')
      order by next_at
      limit 1
      for update skip locked)
  returning v.*;
end $$;
revoke execute on function public.claim_youtube_video() from public, anon, authenticated;
