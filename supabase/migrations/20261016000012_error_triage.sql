-- Errors get triaged like Kaizen Track's: harmless ones (dropped connections, tabs on an old version) are explained and
-- closed automatically; real ones get a diagnosis, can be muted, or handed to Claude to fix.
alter table public.error_events
  add column if not exists diagnosis jsonb,
  add column if not exists auto_resolved boolean not null default false,
  add column if not exists muted_at timestamptz,
  add column if not exists fix_issue_url text;
