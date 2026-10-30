-- The bell is for alerts: something on the person (a reply they owe, a yes they haven't done, work put on them, their
-- report, their account off target). Everything else (who replied to whom, offboarded clients, uploads, other people's
-- escalations) is an update: kept, but left to the daily review and the Overview.
alter table public.notifications add column if not exists alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
