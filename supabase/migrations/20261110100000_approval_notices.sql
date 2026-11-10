-- Kaizen Ads: client notifications and chasing on creative waiting for the client's review (closing the approval loop).
--
-- When creative reaches "With client" for a client whose portal is live, the client's Slack channel gets one short post
-- per batch (at most one a day) with the portal link, and their portal contacts an email. 24 and 48 business hours
-- (1 and 2 business days on the business clock, Mon to Fri 8am to 6pm New York, minus holidays) without a decision bring
-- a gentle reminder, then a second one; at 48 the item lands in customer success's "Waiting on the client" queue. A
-- client who opted into auto-approval has what waited 48 business hours approved for them instead.
--
-- Nothing reaches a client unless every switch is on: the portal is live, Kaizen's client outreach hold is lifted
-- (app_settings client_outreach), and this client's own "Client notifications" switch (below, off by default, execs
-- only). Every notice is kept, keyed by item and kind, so none goes twice. Additive and safe to run again.

-- ─── The client's own switch (off for everyone) ────────────────────────────
alter table public.clients
  add column if not exists client_notifications    boolean not null default false,
  add column if not exists client_notifications_at timestamptz,
  add column if not exists client_notifications_by uuid references public.profiles(id) on delete set null;
comment on column public.clients.client_notifications is 'Client notifications on creative review (Slack post, email, reminders, auto-approval when opted in). Off by default; execs switch it per client';

-- ─── The send log: one row per item and kind (and review round) ────────────
create table if not exists public.approval_notices (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,                 -- '<kind>:<request id>:<round start>': the same notice never goes twice
  client_id   uuid not null references public.clients(id) on delete cascade,
  request_id  uuid references public.requests(id) on delete cascade,
  round_at    timestamptz,                          -- when this round of client review began (requests.stage_entered_at)
  kind        text not null check (kind in ('ready', 'remind_24', 'remind_48', 'escalated', 'auto_approved')),
  status      text not null default 'sending' check (status in ('sending', 'sent', 'held', 'failed')),
  channels    text[] not null default '{}',         -- where it went: slack, email, team
  detail      text,                                 -- what was said, or why it couldn't go
  created_at  timestamptz not null default now()
);
create index if not exists approval_notices_client_idx on public.approval_notices (client_id, created_at desc);
create index if not exists approval_notices_request_idx on public.approval_notices (request_id, kind);
alter table public.approval_notices enable row level security;
drop policy if exists "staff read approval notices" on public.approval_notices;
create policy "staff read approval notices" on public.approval_notices for select to authenticated using (private.staff_can_see_client(client_id));

-- ─── The ticket's timeline shows each post and reminder ─────────────────────
alter table public.request_events drop constraint if exists request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('created', 'stage', 'assign', 'due', 'priority', 'comment', 'upload', 'review', 'copy', 'client_notice'));

-- ─── The bell: an item waiting on the client 48 business hours is on customer success. Every existing prefix is kept
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'feedback-review', 'feedback-reply', 'bible-review', 'bible-digest', 'client-wait')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
