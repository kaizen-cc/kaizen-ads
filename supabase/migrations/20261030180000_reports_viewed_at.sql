alter table public.reports add column if not exists viewed_at timestamptz;
comment on column public.reports.viewed_at is 'When the report''s buyer first opened it (the heads of each line see who has and hasn''t)';
