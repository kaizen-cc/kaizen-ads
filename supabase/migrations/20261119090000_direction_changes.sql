-- A client changing direction mid-production ("evergreen only, stop the team-specific ones", a new price, "focus on
-- campaign Y instead"). Each change is kept with the client's own words and where they said it, and every open task
-- for the client it touches is flagged with where it should go back to, so the team adapts the work already paid for
-- instead of finishing the old version and making a new one too.
-- 1. client_direction_changes: one change (what was, what is now, the quote, the source), open until every flagged
--    task is acted on (handled) or a person says the AI misread it (dismissed). notified: who was told, for Next for me.
-- 2. direction_change_tasks: each open task it touches, on either board, Kaizen or still in Asana, with the verdict,
--    the fix, the suggested stage and what the team did.
-- 3. request_events and email_ticket_events take a 'direction' line on the ticket's timeline.
-- 4. client_calls.direction_checked_at: each read call is checked once.
-- 5. The bell: 'direction' notifications are alerts.
-- Staff who see the client read and update both tables (checked once per query); the cron writes with the service key.
-- Clients never see them.

create table if not exists public.client_direction_changes (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  kind        text not null default 'other' check (kind in ('offer', 'priority', 'stop', 'product', 'messaging', 'audience', 'other')),
  summary     text not null check (length(trim(summary)) > 0 and length(summary) <= 300),
  was_text    text,
  now_text    text,
  quote       text,
  source      text not null check (source in ('slack', 'gmail', 'portal', 'call', 'team', 'assistant')),
  source_ref  text,
  url         text,
  said_at     timestamptz,
  detected_by text not null default 'ai' check (detected_by in ('ai', 'person')),
  created_by  uuid references public.profiles (id) on delete set null,
  status      text not null default 'open' check (status in ('open', 'handled', 'dismissed')),
  handled_by  uuid references public.profiles (id) on delete set null,
  handled_at  timestamptz,
  notified    uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  -- A rerun over the same message never makes the change twice (several null refs are fine: nulls never match)
  constraint client_direction_changes_source_ref unique (source, source_ref)
);
create index if not exists client_direction_changes_client on public.client_direction_changes (client_id, created_at desc);
create index if not exists client_direction_changes_open on public.client_direction_changes (status) where status = 'open';
create index if not exists client_direction_changes_notified on public.client_direction_changes using gin (notified) where status = 'open';

create table if not exists public.direction_change_tasks (
  id              uuid primary key default gen_random_uuid(),
  change_id       uuid not null references public.client_direction_changes (id) on delete cascade,
  client_id       uuid not null references public.clients (id) on delete cascade,
  task_kind       text not null check (task_kind in ('asana_creative', 'asana_email', 'creative', 'email')),
  task_ref        text not null,
  title           text not null default '',
  stage_at_flag   text,
  verdict         text not null default 'affected' check (verdict in ('affected', 'maybe')),
  why             text,
  fix             text not null default 'design' check (fix in ('design', 'copy', 'both', 'brief', 'stop')),
  suggested_stage text,
  action          text not null default 'pending' check (action in ('pending', 'sent_back', 'kept', 'stopped')),
  to_stage        text,
  acted_by        uuid references public.profiles (id) on delete set null,
  acted_at        timestamptz,
  created_at      timestamptz not null default now(),
  unique (change_id, task_kind, task_ref)
);
create index if not exists direction_change_tasks_task on public.direction_change_tasks (task_kind, task_ref) where action = 'pending';
create index if not exists direction_change_tasks_client on public.direction_change_tasks (client_id);

alter table public.client_direction_changes enable row level security;
alter table public.direction_change_tasks enable row level security;

drop policy if exists "staff read direction changes" on public.client_direction_changes;
create policy "staff read direction changes" on public.client_direction_changes for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));
drop policy if exists "staff update direction changes" on public.client_direction_changes;
create policy "staff update direction changes" on public.client_direction_changes for update to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false))
  with check ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

drop policy if exists "staff read direction change tasks" on public.direction_change_tasks;
create policy "staff read direction change tasks" on public.direction_change_tasks for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));
drop policy if exists "staff update direction change tasks" on public.direction_change_tasks;
create policy "staff update direction change tasks" on public.direction_change_tasks for update to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false))
  with check ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

-- ─── The ticket's timeline: a 'direction' line (every earlier kind kept) ────
alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('created', 'stage', 'assign', 'due', 'priority', 'comment', 'upload', 'review', 'copy', 'client_notice', 'direction'));

alter table public.email_ticket_events drop constraint if exists email_ticket_events_kind_check;
alter table public.email_ticket_events add constraint email_ticket_events_kind_check
  check (kind in ('created', 'stage', 'assign', 'due', 'priority', 'comment', 'copy', 'design', 'review', 'client', 'route', 'built', 'live', 'asana', 'notice', 'direction'));

-- ─── Calls: each read call is checked for a change of direction once ───────
alter table public.client_calls add column if not exists direction_checked_at timestamptz;

-- ─── The bell: a client changing direction is an alert. Every existing prefix is kept
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'feedback-review', 'feedback-reply', 'bible-review', 'bible-digest', 'client-wait', 'connector-ask', 'connector-ready', 'connector-declined', 'direction')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
