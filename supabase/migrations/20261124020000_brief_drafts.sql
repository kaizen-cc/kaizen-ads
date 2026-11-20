-- Briefs in progress, kept in the database as they're typed (owner, Nov 20 2026: "save the last brief I created if I'm
-- logged out or if Kaizen OS shuts down"). The whole request form as it stands (client, formats, brief, references,
-- the AI work done), per person, so it waits for them on any device and after signing out. Several per person; one
-- disappears once it's sent. Only its owner reads or changes it.
create table if not exists public.brief_drafts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- A brief that belongs to something (a drafted brief, an Asana task being moved over): one draft per thing per person
  context text,
  client_id uuid references public.clients (id) on delete set null,
  title text,
  step int not null default 0,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists brief_drafts_mine on public.brief_drafts (profile_id, updated_at desc);
create unique index if not exists brief_drafts_one_per_context on public.brief_drafts (profile_id, context) where context is not null;
alter table public.brief_drafts enable row level security;
create policy "own brief drafts" on public.brief_drafts for all to authenticated
  using (profile_id = (select private.current_profile_id()))
  with check (profile_id = (select private.current_profile_id()));
