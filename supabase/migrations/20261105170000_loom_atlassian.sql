-- Every new Loom pulled automatically through Atlassian's official MCP server (the Loom workspace linked to an
-- Atlassian Cloud site), instead of shared folders. The cron's Loom step lists the videos created since the last check
-- and queues them like any other intake path (source atlassian); a video whose public transcript can't be read
-- (private, or shared to the workspace only) has its transcript asked of Atlassian instead.

alter table public.loom_videos drop constraint if exists loom_videos_source_check;
alter table public.loom_videos add constraint loom_videos_source_check check (source in ('slack', 'webhook', 'bulk', 'client', 'folder', 'atlassian'));

-- The one connection: when it last looked, where it stopped, who it reads as. Never holds a secret (the token lives in
-- the environment).
create table if not exists public.loom_connection (
  id              int primary key default 1 check (id = 1),
  -- Videos created at or after this were already looked for (the next check starts here, with some overlap)
  cursor          timestamptz,
  -- A walk in progress (a long check, or an exec's backfill): the date it reaches back to (or everything), when it
  -- began, and the page it reached, so the next run continues it
  walk_from       timestamptz,
  walk_all        boolean not null default false,
  walk_backfill   boolean not null default false,
  walk_started_at timestamptz,
  page_cursor     text,
  account_label   text,
  cloud_id        text,
  last_sync_at    timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  -- Videos seen on the last check, and every video queued from Atlassian so far
  last_found      int not null default 0,
  video_count     int not null default 0,
  updated_at      timestamptz not null default now()
);
alter table public.loom_connection enable row level security;
drop policy if exists "staff read loom connection" on public.loom_connection;
create policy "staff read loom connection" on public.loom_connection for select to authenticated using (private.is_staff());
