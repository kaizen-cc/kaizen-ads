-- Taking a report off "Reports generated": one that never went out is deleted; one that was sent stays in the client's
-- history and is only hidden from the list.
alter table public.report_bundles add column if not exists hidden_at timestamptz;
alter table public.reports add column if not exists hidden_at timestamptz;
