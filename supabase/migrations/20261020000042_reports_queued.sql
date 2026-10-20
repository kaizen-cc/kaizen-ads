-- Reports wait in a queue and are drafted a few at a time by the reports job
alter table public.reports drop constraint reports_status_check;
alter table public.reports add constraint reports_status_check check (status in ('queued', 'drafting', 'draft', 'submitted', 'posted', 'skipped', 'failed'));
alter table public.reports alter column status set default 'queued';
