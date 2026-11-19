-- Client changes kept with the right team (owner, Nov 19 2026). Each change says whose work it is (lines: the client
-- page sections it's kept in, meta, google, tiktok, creative, email, social) and whether it's a real change of
-- direction or a revision to one piece in progress (scope). Revisions are flagged on that piece for whoever holds it,
-- never shown as the client changing direction.
alter table public.client_direction_changes add column if not exists scope text not null default 'direction' check (scope in ('direction', 'revision'));
alter table public.client_direction_changes add column if not exists lines text[] not null default '{}';

-- Every change so far: its lines from the tasks it touches
update public.client_direction_changes c
set lines = coalesce((
  select array_agg(distinct case when t.task_kind in ('creative', 'asana_creative') then 'creative' else 'email' end)
  from public.direction_change_tasks t where t.change_id = c.id
), '{}')
where c.lines = '{}';

create index if not exists client_direction_changes_open_scope on public.client_direction_changes (client_id, scope) where status = 'open';
