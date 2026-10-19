-- Asana's Creative board, mirrored while the team moves over: every open task as a "shadow" ticket in the matching
-- stage, kept in step every few minutes. Shadows are read-only and set nothing off (no AI, deadlines or allotment)
-- until someone migrates one into a real Kaizen Ads ticket, in the stage it had reached.
create table public.asana_tasks (
  gid            text primary key,
  name           text not null,
  notes          text,
  section        text,
  stage          text,                       -- our stage for the Asana column (null when the column isn't mapped)
  client_id      uuid references public.clients (id) on delete set null,
  client_ref     text,                       -- the Client ID or name as Asana has it
  platform       text,
  format         text,
  priority       text,
  assignee_name  text,
  assignee_email text,
  profile_id     uuid references public.profiles (id) on delete set null,
  due_on         date,
  url            text,
  fields         jsonb not null default '{}',
  moves          jsonb not null default '[]', -- [{ from, to, at }] as seen by the sync
  asana_created_at  timestamptz,
  asana_modified_at timestamptz,
  open           boolean not null default true, -- false once it's completed or gone from the board in Asana
  request_id     uuid references public.requests (id) on delete set null,
  migrated_at    timestamptz,
  migrated_by    uuid references public.profiles (id) on delete set null,
  synced_at      timestamptz not null default now()
);
create index asana_tasks_board on public.asana_tasks (open, stage) where request_id is null;
alter table public.asana_tasks enable row level security;
create policy "staff read asana mirror" on public.asana_tasks for select to authenticated using (private.is_staff());
