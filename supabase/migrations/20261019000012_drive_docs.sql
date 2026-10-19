-- Docs anywhere in the Workspace (Google Docs and Slides in everyone's Drive), read every 30 minutes: one about a
-- client joins its context and memory. Kept per file so a doc is read again only when its text changes. Docs not
-- about a client keep only their name and owner here, nothing of what they say.
create table public.drive_docs (
  file_id     text primary key,
  name        text not null,
  mime        text,
  owner_email text,
  url         text,
  modified_at timestamptz,
  read_at     timestamptz,
  text_hash   text,
  status      text not null default 'read' check (status in ('read', 'skipped', 'failed')),
  client_id   uuid references public.clients (id) on delete set null,
  kind        text,
  summary     text,
  error       text
);
create index on public.drive_docs (client_id) where client_id is not null;
alter table public.drive_docs enable row level security;
create policy "execs and leads read docs" on public.drive_docs for select to authenticated using (private.is_exec_or_lead());

alter table public.client_memory drop constraint client_memory_source_check;
alter table public.client_memory add constraint client_memory_source_check check (source = any (array['team', 'client', 'review', 'copy', 'lab', 'audit', 'sprint', 'network', 'call', 'drive']));
