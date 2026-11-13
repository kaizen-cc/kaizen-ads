-- The history of a report: skipped (and why), brought back. Entries {action, reason, note, by, byName, at}.
alter table public.reports add column if not exists log jsonb not null default '[]'::jsonb;
