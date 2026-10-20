-- What the designer or editor had to change from the brief because something in it wasn't possible, said at upload
alter table public.requests add column if not exists brief_changes jsonb not null default '[]'::jsonb;
