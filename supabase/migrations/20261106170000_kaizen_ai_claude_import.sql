-- Kaizen AI: import chat history from Claude (claude.ai's data export). Each import is a row in ai_imports; every
-- conversation in it becomes the person's own private thread (source = 'claude', source_id = Claude's conversation
-- uuid, so the same conversation is never imported twice), with its messages at their original times. Deleting the
-- import deletes its threads. A long imported thread keeps a summary of its older turns (written once, by the fast
-- model) so it can be continued without sending the whole history. Docs from a Claude project ride along as the
-- thread's private notes.

create table if not exists public.ai_imports (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  source text not null default 'claude' check (source in ('claude')),
  file_name text,
  conversations integer not null default 0,
  created integer not null default 0,
  skipped integer not null default 0,
  status text not null default 'running' check (status in ('running', 'done')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ai_imports_owner_idx on public.ai_imports (profile_id, created_at desc);

alter table public.ai_imports enable row level security;
drop policy if exists "ai imports own" on public.ai_imports;
create policy "ai imports own" on public.ai_imports for all to authenticated
  using (private.is_staff() and profile_id = private.current_profile_id())
  with check (private.is_staff() and profile_id = private.current_profile_id());

alter table public.ai_threads
  add column if not exists source text check (source in ('claude')),
  add column if not exists source_id text,
  add column if not exists import_id uuid references public.ai_imports(id) on delete cascade,
  -- false while a long conversation is still arriving in parts (an interrupted import is redone, not doubled)
  add column if not exists source_complete boolean not null default true,
  add column if not exists history_summary text,
  -- the summary covers the messages up to and including this time
  add column if not exists history_summary_upto timestamptz,
  -- [{ name, text }] private notes (a Claude project's docs), read with every message in the thread
  add column if not exists notes jsonb not null default '[]';

create unique index if not exists ai_threads_source_uidx on public.ai_threads (profile_id, source, source_id) where source_id is not null;
create index if not exists ai_threads_import_idx on public.ai_threads (import_id) where import_id is not null;
