-- Learning loops: audits and sprints write lasting lessons into client memory (every agent reads it), and buyers can
-- add their own moves to a sprint, which the system fleshes out and asks about so the daily check knows what to look for.
alter table public.client_memory drop constraint client_memory_source_check;
alter table public.client_memory add constraint client_memory_source_check check (source = any (array['team', 'client', 'review', 'copy', 'lab', 'audit', 'sprint']));

alter table public.sprint_actions
  add column source text not null default 'audit' check (source in ('audit', 'buyer')),
  add column watch text,                              -- what the checks look for to judge this move
  add column questions jsonb not null default '[]',   -- what the system still needs to know about a move someone added
  add column answers jsonb not null default '[]',
  add column added_by uuid references public.profiles (id) on delete set null,
  add column learned boolean not null default false;  -- its lesson has gone to client memory

create policy "staff add sprint actions" on public.sprint_actions for insert to authenticated
  with check (exists (select 1 from public.optimization_sprints s where s.id = sprint_id and private.staff_can_see_client(s.client_id)));
