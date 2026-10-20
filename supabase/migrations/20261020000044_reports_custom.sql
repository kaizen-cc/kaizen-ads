-- A report on demand: month to date, or any dates a client asks about
alter table public.reports drop constraint reports_kind_check;
alter table public.reports add constraint reports_kind_check check (kind in ('weekly', 'monthly', 'custom'));
