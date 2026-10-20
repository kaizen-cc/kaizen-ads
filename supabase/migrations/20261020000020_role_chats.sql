-- Talk to a whole agent (the Media Buyer, the Strategist…) like an employee. It knows its core and every one of its
-- skills; feedback turns into proposed edits across them (each says which skill or the core it touches), applied on
-- click by an exec. One running conversation per agent. Skill-level chats stay in ai_agent_chats.

create table public.ai_role_chats (
  id          bigint generated always as identity primary key,
  role_key    text not null references public.ai_roles(key) on delete cascade,
  role        text not null check (role in ('user', 'agent')),
  content     text not null,
  changes     jsonb not null default '[]',   -- the agent's proposed edits, each with the skill it touches; applied: true when used
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index on public.ai_role_chats (role_key, created_at);
alter table public.ai_role_chats enable row level security;
create policy "execs use role chats" on public.ai_role_chats for all to authenticated using (private.is_exec()) with check (private.is_exec());
