-- Kaizen AI: a Claude-like chat for the team. Each person has their own threads (optionally pinned to a client and
-- shared read-only with teammates), the messages in them (with attachments, tool calls and the cards tools made), and
-- saved prompt templates (their own, or shared with the team). Files people attach live in the private ai-files bucket;
-- the server hands out signed upload links, so nothing big passes through the app.

create table if not exists public.ai_threads (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'New chat',
  client_id uuid references public.clients(id) on delete set null,
  -- the client was picked or confirmed by the person (a detected client waits for a confirm)
  client_confirmed boolean not null default false,
  -- the agent the person switched to; null = picked from what each message is about
  agent_key text,
  model text not null default 'opus' check (model in ('opus', 'sonnet')),
  pinned boolean not null default false,
  shared_with uuid[] not null default '{}',
  archived_at timestamptz,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_threads_owner_idx on public.ai_threads (profile_id, last_message_at desc) where archived_at is null;
create index if not exists ai_threads_shared_idx on public.ai_threads using gin (shared_with);
create index if not exists ai_threads_client_idx on public.ai_threads (client_id) where client_id is not null;

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.ai_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  -- [{ path, name, mime, bytes, kind: image|pdf|doc|video|text, frames?: [path], transcript?: text, text?: text }]
  attachments jsonb not null default '[]',
  -- [{ id, name, input, label, ok, ms, summary }] what the assistant looked up or did on the way
  tools jsonb not null default '[]',
  -- [{ type, ... }] rich results (metrics tables, copy sets, a brief, a report link, an ad change plan)
  cards jsonb not null default '[]',
  agent_key text,
  model text,
  usage jsonb,
  error text,
  stopped boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ai_messages_thread_idx on public.ai_messages (thread_id, created_at);

create table if not exists public.ai_templates (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  prompt text not null,
  -- the roles it's suggested to (null = everyone)
  roles text[],
  shared boolean not null default false,
  uses integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_templates_owner_idx on public.ai_templates (profile_id);
create index if not exists ai_templates_shared_idx on public.ai_templates (shared) where shared;

alter table public.ai_threads enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_templates enable row level security;

-- Threads: the owner reads and changes them; teammates they're shared with read them
drop policy if exists "ai threads read" on public.ai_threads;
create policy "ai threads read" on public.ai_threads for select to authenticated
  using (private.is_staff() and (profile_id = private.current_profile_id() or private.current_profile_id() = any (shared_with)));
drop policy if exists "ai threads own" on public.ai_threads;
create policy "ai threads own" on public.ai_threads for all to authenticated
  using (private.is_staff() and profile_id = private.current_profile_id())
  with check (private.is_staff() and profile_id = private.current_profile_id());

drop policy if exists "ai messages read" on public.ai_messages;
create policy "ai messages read" on public.ai_messages for select to authenticated
  using (exists (select 1 from public.ai_threads t where t.id = thread_id and private.is_staff() and (t.profile_id = private.current_profile_id() or private.current_profile_id() = any (t.shared_with))));
drop policy if exists "ai messages own" on public.ai_messages;
create policy "ai messages own" on public.ai_messages for all to authenticated
  using (exists (select 1 from public.ai_threads t where t.id = thread_id and t.profile_id = private.current_profile_id()))
  with check (exists (select 1 from public.ai_threads t where t.id = thread_id and t.profile_id = private.current_profile_id()));

drop policy if exists "ai templates read" on public.ai_templates;
create policy "ai templates read" on public.ai_templates for select to authenticated
  using (private.is_staff() and (shared or profile_id = private.current_profile_id()));
drop policy if exists "ai templates own" on public.ai_templates;
create policy "ai templates own" on public.ai_templates for all to authenticated
  using (private.is_staff() and profile_id = private.current_profile_id())
  with check (private.is_staff() and profile_id = private.current_profile_id());

-- Attachments: private; the server signs uploads and reads, scoped to the person's own folder (<profile id>/...)
insert into storage.buckets (id, name, public, file_size_limit)
values ('ai-files', 'ai-files', false, 524288000)
on conflict (id) do nothing;
