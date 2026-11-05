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

-- The token lasts a year at most: its expiry (set by an exec on the card; ATLASSIAN_TOKEN_EXPIRES_AT otherwise), the
-- notices already sent for that date (30, 14, 7, 1 days before, each once), the day it was last checked, and when
-- Atlassian started refusing the token (told to the execs once, until it's accepted again).
alter table public.loom_connection add column if not exists token_expires_at date;
alter table public.loom_connection add column if not exists expiry_notified int[] not null default '{}';
alter table public.loom_connection add column if not exists expiry_notified_for date;
alter table public.loom_connection add column if not exists expiry_checked_on date;
alter table public.loom_connection add column if not exists auth_failed_at timestamptz;
alter table public.loom_connection add column if not exists auth_notified_at timestamptz;

-- The bell: a connection about to stop working (or already refused) is an alert for the execs
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;