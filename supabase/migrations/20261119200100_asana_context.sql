-- Everything the Asana task carries, kept on the mirror so the board sheets show it and the migration can carry it
-- over: start date, who created it, attachments (name and link; the file stays in Asana), subtasks.
alter table public.asana_tasks
  add column if not exists start_on date,
  add column if not exists created_by_name text,
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists subtasks jsonb not null default '[]'::jsonb,
  add column if not exists details_read_at timestamptz;

alter table public.email_asana_tasks
  add column if not exists start_on date,
  add column if not exists created_by_name text,
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists subtasks jsonb not null default '[]'::jsonb,
  add column if not exists details_read_at timestamptz;

comment on column public.asana_tasks.attachments is 'Asana attachments: [{ gid, name, url, host, size, at }]';
comment on column public.asana_tasks.subtasks is 'Asana subtasks: [{ gid, name, done, assignee, dueOn, url }]';
comment on column public.email_asana_tasks.attachments is 'Asana attachments: [{ gid, name, url, host, size, at }]';
comment on column public.email_asana_tasks.subtasks is 'Asana subtasks: [{ gid, name, done, assignee, dueOn, url }]';
