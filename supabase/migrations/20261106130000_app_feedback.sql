-- Feedback from the team about Kaizen Ads itself: a bug, an idea, or something confusing, left from the bubble on any
-- page with what was on screen (page, viewport, recent console errors and failed requests, the app version). Each
-- report is read by AI and grouped with the same thing said before, so a group counts its repeats and the distinct
-- people behind them and is prioritized from that. Execs run the groups (status, assignee, Mark fixed, which tells
-- everyone who reported it); each author sees their own reports and where they stand.

create table public.app_feedback_groups (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  summary          text,
  type             text not null default 'bug' check (type in ('bug', 'idea', 'confusing')),
  area             text not null default 'Other',
  status           text not null default 'new' check (status in ('new', 'planned', 'in_progress', 'fixed', 'wont_fix')),
  assignee_id      uuid references public.profiles (id) on delete set null,
  severity         text not null default 'low' check (severity in ('low', 'medium', 'high')),
  blocks_work      boolean not null default false,
  reports          integer not null default 0,
  people           integer not null default 0,
  priority         numeric not null default 0,
  -- The error the error monitor already recorded for it, when the report came with one (error_events.fingerprint)
  error_fingerprint text,
  first_reported_at timestamptz not null default now(),
  last_reported_at  timestamptz not null default now(),
  fixed_at         timestamptz,
  fixed_by         uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on public.app_feedback_groups (status, priority desc);

create table public.app_feedback (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null default private.current_profile_id() references public.profiles (id) on delete cascade,
  type           text not null check (type in ('bug', 'idea', 'confusing')),
  message        text not null check (length(message) between 1 and 5000),
  page_url       text,
  route          text,
  client_id      uuid references public.clients (id) on delete set null,
  -- browser, viewport, role, version, console errors, failed requests
  context        jsonb not null default '{}'::jsonb,
  screenshot_path text,
  group_id       uuid references public.app_feedback_groups (id) on delete set null,
  -- What the AI read from it
  summary        text,
  area           text,
  severity       text check (severity in ('low', 'medium', 'high')),
  blocks_work    boolean not null default false,
  triaged_at     timestamptz,
  triage_tries   integer not null default 0,
  created_at     timestamptz not null default now()
);
create index on public.app_feedback (profile_id, created_at desc);
create index on public.app_feedback (group_id);
create index on public.app_feedback (created_at) where triaged_at is null;

alter table public.app_feedback enable row level security;
alter table public.app_feedback_groups enable row level security;

-- Staff leave their own; the author reads theirs; execs read all
create policy "staff leave own feedback" on public.app_feedback for insert to authenticated
  with check (private.is_staff() and profile_id = private.current_profile_id());
create policy "author or exec reads feedback" on public.app_feedback for select to authenticated
  using (profile_id = private.current_profile_id() or private.is_exec());

-- Execs read and run every group; an author reads the groups their reports are in (for the status)
create policy "execs read feedback groups" on public.app_feedback_groups for select to authenticated
  using (private.is_exec() or exists (select 1 from public.app_feedback f where f.group_id = app_feedback_groups.id and f.profile_id = private.current_profile_id()));
create policy "execs run feedback groups" on public.app_feedback_groups for update to authenticated
  using (private.is_exec()) with check (private.is_exec());

-- Screenshots: private, written by the server, read through signed links
insert into storage.buckets (id, name, public, file_size_limit) values ('feedback', 'feedback', false, 10485760) on conflict (id) do nothing;

-- "Fixed: …" for the people who reported it, the weekly digest and an urgent blocker for execs are alerts (the bell)
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
