-- Each Asana task's full history from its stories (column moves and reassignments, with who and when), for how long
-- creative takes, how many revisions happen and who holds what. Read once per task and again when it changes.
alter table public.asana_tasks add column if not exists history jsonb not null default '[]'::jsonb;
alter table public.asana_tasks add column if not exists history_read_at timestamptz;
