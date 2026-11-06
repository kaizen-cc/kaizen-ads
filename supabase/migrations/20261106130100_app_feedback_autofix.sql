-- Feedback that fixes itself: a small, contained bug goes to the same Claude fix pipeline as the error monitor (a
-- GitHub issue labelled claude-fix + auto-merge: Claude opens a pull request, every check runs, and it merges itself
-- when they pass). Big issues (data, security, money, ad-account writes, permissions, the database, several areas)
-- and feature requests wait for an exec's review: approve to build (a pull request to review, never merged by
-- itself), ask the reporter for more, or won't do. Every step is logged on the group.

alter table public.app_feedback_groups
  add column scope         text not null default 'small_bug' check (scope in ('small_bug', 'big_issue', 'feature')),
  add column scope_reason  text,
  -- auto_fix: on its way through the pipeline · review: waiting on an exec · build: approved, a pull request to review
  add column lane          text not null default 'review' check (lane in ('auto_fix', 'review', 'build')),
  add column plan          text,
  add column fix_issue_number integer,
  add column fix_issue_url text,
  add column fix_pr_url    text,
  add column fix_commit_url text,
  add column fix_state     text check (fix_state in ('queued', 'working', 'pr_open', 'checks_failed', 'merged', 'no_change')),
  add column fix_attempts  integer not null default 0,
  add column fix_started_at timestamptz;
create index on public.app_feedback_groups (fix_state) where fix_state is not null;

alter table public.app_feedback
  add column scope text check (scope in ('small_bug', 'big_issue', 'feature'));

-- What happened to a group, in order: reported, triaged, sent to be fixed, pull request, checks, fixed, an exec's
-- decision or question. "shared" ones are shown to the people who reported it too.
create table public.app_feedback_events (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.app_feedback_groups (id) on delete cascade,
  actor_id   uuid references public.profiles (id) on delete set null,
  kind       text not null,
  body       text,
  link       text,
  shared     boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.app_feedback_events (group_id, created_at);
alter table public.app_feedback_events enable row level security;
create policy "execs read feedback events" on public.app_feedback_events for select to authenticated
  using (private.is_exec() or (shared and exists (select 1 from public.app_feedback f where f.group_id = app_feedback_events.group_id and f.profile_id = private.current_profile_id())));

-- Review cards for execs and replies to the reporters are alerts too
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'feedback-review', 'feedback-reply',
    -- added alongside by the Brand Bible review work (kept so neither change drops the other)
    'bible-review', 'bible-digest')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
