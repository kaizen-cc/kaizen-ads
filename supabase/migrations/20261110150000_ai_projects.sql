-- Kaizen AI projects, like Claude's: a name, a description, custom instructions (read as context by every chat in
-- it), project knowledge (files and text docs, their text kept for the model), its chats, an optional client (whose
-- context comes with every chat, as when a chat is pinned to them) and the connectors it expects (keys like
-- 'shopify'; connecting is in Settings › Connections).
--
-- Who can do what: the creator owns it (an editor who can also delete it). Visibility: private (only the owner),
-- people (the owner and the people added, each a viewer or an editor) or everyone (every staff member can view;
-- everyone_can_edit makes them all editors). People added keep their role in an everyone project. Execs can always
-- see every project. Viewers read the knowledge and start chats in it (their chats stay their own, private unless
-- they share them); editors change the name, instructions, knowledge and sharing. private.ai_project_role mirrors
-- projectRole in src/lib/kaizen-ai/projects.ts.
--
-- Imported from Claude: source = 'claude' and source_id = Claude's project uuid, unique per creator, so importing
-- the same export again never makes a second copy. Knowledge files live in the existing private ai-files bucket
-- (the uploader's folder), read by the server; no new bucket.

create table if not exists public.ai_projects (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'Untitled project' check (char_length(name) between 1 and 120),
  description text not null default '',
  instructions text not null default '',
  client_id uuid references public.clients(id) on delete set null,
  connectors text[] not null default '{}',
  visibility text not null default 'private' check (visibility in ('private', 'people', 'everyone')),
  everyone_can_edit boolean not null default false,
  source text check (source in ('claude')),
  source_id text,
  import_id uuid references public.ai_imports(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ai_projects_source_uidx on public.ai_projects (created_by, source, source_id) where source_id is not null;
create index if not exists ai_projects_owner_idx on public.ai_projects (created_by);
create index if not exists ai_projects_everyone_idx on public.ai_projects (visibility) where visibility = 'everyone';

create table if not exists public.ai_project_members (
  project_id uuid not null references public.ai_projects(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, profile_id)
);
create index if not exists ai_project_members_profile_idx on public.ai_project_members (profile_id);

create table if not exists public.ai_project_docs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.ai_projects(id) on delete cascade,
  -- text: written or pasted in Kaizen AI (or a Claude project's doc); file: uploaded, its text read on the way in
  kind text not null default 'text' check (kind in ('text', 'file')),
  name text not null default 'Document',
  path text,
  mime text,
  bytes bigint,
  text text,
  chars integer not null default 0,
  note text,
  source_id text,
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists ai_project_docs_project_idx on public.ai_project_docs (project_id, created_at);

alter table public.ai_threads
  add column if not exists project_id uuid references public.ai_projects(id) on delete set null,
  -- the Claude project an imported chat was in (linked once that project is imported, by whoever made it)
  add column if not exists source_project text;
create index if not exists ai_threads_project_idx on public.ai_threads (project_id, last_message_at desc) where project_id is not null;
create index if not exists ai_threads_source_project_idx on public.ai_threads (source_project) where source_project is not null;

-- The current person's role on a project: owner, editor, viewer, or null (can't see it)
create or replace function private.ai_project_role(p_project uuid) returns text
language sql stable security definer set search_path = '' as $$
  with p as (select created_by, visibility, everyone_can_edit from public.ai_projects where id = p_project),
       me as (select private.current_profile_id() as id),
       m as (select role from public.ai_project_members, me where project_id = p_project and profile_id = me.id)
  select case
    when (select id from me) is null or not exists (select 1 from p) then null
    when (select created_by from p) = (select id from me) then 'owner'
    when (select visibility from p) = 'everyone' and (select everyone_can_edit from p) then 'editor'
    when (select visibility from p) <> 'private' and (select role from m) = 'editor' then 'editor'
    when (select visibility from p) = 'everyone' then 'viewer'
    when (select visibility from p) = 'people' and (select role from m) = 'viewer' then 'viewer'
    when private.is_exec() then 'viewer'
    else null
  end
$$;
revoke execute on function private.ai_project_role(uuid) from public, anon;
grant execute on function private.ai_project_role(uuid) to authenticated;

alter table public.ai_projects enable row level security;
alter table public.ai_project_members enable row level security;
alter table public.ai_project_docs enable row level security;

drop policy if exists "ai projects read" on public.ai_projects;
create policy "ai projects read" on public.ai_projects for select to authenticated
  using (private.is_staff() and private.ai_project_role(id) is not null);
drop policy if exists "ai projects create" on public.ai_projects;
create policy "ai projects create" on public.ai_projects for insert to authenticated
  with check (private.is_staff() and created_by = private.current_profile_id());
drop policy if exists "ai projects edit" on public.ai_projects;
create policy "ai projects edit" on public.ai_projects for update to authenticated
  using (private.ai_project_role(id) in ('owner', 'editor'))
  with check (private.ai_project_role(id) in ('owner', 'editor'));
drop policy if exists "ai projects delete" on public.ai_projects;
create policy "ai projects delete" on public.ai_projects for delete to authenticated
  using (private.ai_project_role(id) = 'owner');

drop policy if exists "ai project members read" on public.ai_project_members;
create policy "ai project members read" on public.ai_project_members for select to authenticated
  using (private.is_staff() and private.ai_project_role(project_id) is not null);
drop policy if exists "ai project members edit" on public.ai_project_members;
create policy "ai project members edit" on public.ai_project_members for all to authenticated
  using (private.ai_project_role(project_id) in ('owner', 'editor'))
  with check (private.ai_project_role(project_id) in ('owner', 'editor'));

drop policy if exists "ai project docs read" on public.ai_project_docs;
create policy "ai project docs read" on public.ai_project_docs for select to authenticated
  using (private.is_staff() and private.ai_project_role(project_id) is not null);
drop policy if exists "ai project docs edit" on public.ai_project_docs;
create policy "ai project docs edit" on public.ai_project_docs for all to authenticated
  using (private.ai_project_role(project_id) in ('owner', 'editor'))
  with check (private.ai_project_role(project_id) in ('owner', 'editor'));

-- A chat can only be put in a project its owner can see
drop policy if exists "ai threads own" on public.ai_threads;
create policy "ai threads own" on public.ai_threads for all to authenticated
  using (private.is_staff() and profile_id = private.current_profile_id())
  with check (private.is_staff() and profile_id = private.current_profile_id() and (project_id is null or private.ai_project_role(project_id) is not null));
