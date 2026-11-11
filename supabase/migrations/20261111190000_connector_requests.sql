-- Requests to enable a connector in Kaizen AI. Anyone on the team browses the whole Directory from Kaizen AI and asks
-- for one that isn't enabled for their role ("Request to enable", with an optional note). Every exec hears about it on
-- the bell and by email with Enable one click away; enabling or declining (with a reason) tells everyone who asked.
-- ref is the Directory entry's registry name ("kaizen.directory/asana"), or "connector:<id>" for a connector the team
-- already has that isn't offered to the person's role. One pending request per person per connector: asking again
-- updates the note. People read their own; execs read and decide all of them. Safe to run twice.

create table if not exists public.ai_connector_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  ref text not null,
  title text not null,
  icon_url text,
  note text,
  status text not null default 'pending' check (status in ('pending', 'enabled', 'declined')),
  -- why it was declined (sent back to the people who asked)
  reason text,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ai_connector_requests_one_pending on public.ai_connector_requests (profile_id, ref) where status = 'pending';
create index if not exists ai_connector_requests_pending_ref on public.ai_connector_requests (ref) where status = 'pending';

alter table public.ai_connector_requests enable row level security;

drop policy if exists "connector requests own read" on public.ai_connector_requests;
create policy "connector requests own read" on public.ai_connector_requests for select to authenticated
  using (private.is_staff() and (profile_id = private.current_profile_id() or private.is_exec()));
drop policy if exists "connector requests own insert" on public.ai_connector_requests;
create policy "connector requests own insert" on public.ai_connector_requests for insert to authenticated
  with check (private.is_staff() and profile_id = private.current_profile_id() and status = 'pending');
drop policy if exists "connector requests exec decide" on public.ai_connector_requests;
create policy "connector requests exec decide" on public.ai_connector_requests for update to authenticated
  using (private.is_exec()) with check (private.is_exec());

-- ─── The bell: a request, it's ready to connect, and declined are alerts. Every existing prefix is kept
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'feedback-review', 'feedback-reply', 'bible-review', 'bible-digest', 'client-wait', 'connector-ask', 'connector-ready', 'connector-declined')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
