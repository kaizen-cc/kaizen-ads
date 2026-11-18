-- Promises from calls reach the right people, once, and say what they are.
-- 1. The database no longer tells six people about every commitment the moment it is saved (the head of Google, the
--    head of Meta, three execs and the buyer, with a generic title). The app routes each one by its kind and the
--    client's seats after the calls are read (src/lib/promise-routing.ts), merging the same meeting recorded by two
--    note-takers first.
-- 2. 'promise' notices are alerts: they show in the bell (and critical ones email). Every existing prefix is kept.
-- 3. The generic "Promised on a call with ..." notices already sent are cleared: the routing sends the real ones.

drop trigger if exists notify_promise on public.call_commitments;
drop function if exists private.notify_promise();

alter table public.call_commitments
  add column if not exists routed_at timestamptz,
  add column if not exists routed_to uuid[] not null default '{}',
  add column if not exists urgent boolean not null default false,
  add column if not exists merged_into uuid references public.call_commitments (id) on delete set null;
create index if not exists call_commitments_routed_to on public.call_commitments using gin (routed_to);

-- Commitments routed (and told) by the old trigger are not told again. Only the last two days are routed anew,
-- which is the backfill: the next calls run picks up whatever is still open from today and yesterday.
update public.call_commitments c set routed_at = now()
 where c.routed_at is null
   and exists (select 1 from public.client_calls k where k.id = c.call_id and k.occurred_at < now() - interval '2 days');

update public.notifications
   set cleared_at = coalesce(cleared_at, now()), emailed_at = coalesce(emailed_at, now())
 where kind = 'promise' and key like 'promise:%' and key not like 'promise:n:%' and title like 'Promised on a call with %';

-- ─── The bell: promise notices are alerts. Every existing prefix is kept ('watch' from account watch included)
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'feedback-review', 'feedback-reply', 'bible-review', 'bible-digest', 'client-wait', 'connector-ask', 'connector-ready', 'connector-declined', 'direction', 'watch', 'promise')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;

-- ─── Delegating: a "Brief ready" or call promise item handed to a teammate is a task for them (agent_asks, the path
-- send_to_teammate uses); source_ref ties it back to the item ("promise:<commitment id>"), so the original shows
-- "Delegated to <name>" and clears when they mark it done.
alter table public.agent_asks add column if not exists source_ref text;
create index if not exists agent_asks_source_ref on public.agent_asks (asked_by, source_ref) where source_ref is not null;
