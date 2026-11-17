-- Calls with the AI agents, part two.
-- 1. What a call hears is held for review: each item in ai_role_calls.learned now has a status (pending, kept, tossed)
--    and nothing is written to the agent until a person keeps it. reviewed_at is set once nothing is pending; a call
--    left with pending items surfaces in that person's Overview (Next for me) and on the agent's page.
-- 2. Calls pick up where they left off: when it was last talked in (last_turn_at), a short summary and topic written at
--    the end, and the call it follows (resumed_from, resume_mode: continue, soon, later_today or fresh).
-- 3. Reminders and tasks asked of an agent on a call or in its chat (agent_asks): on the owner's Next for me, credited
--    to who asked and via which agent. Nothing goes to a client.

alter table public.ai_role_calls
  add column if not exists last_turn_at timestamptz,
  add column if not exists summary text,
  add column if not exists topic text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists resumed_from uuid references public.ai_role_calls(id) on delete set null,
  add column if not exists resume_mode text;

do $$ begin
  alter table public.ai_role_calls add constraint ai_role_calls_resume_mode_check check (resume_mode is null or resume_mode in ('continue', 'soon', 'later_today', 'fresh'));
exception when duplicate_object then null; end $$;

-- Calls from before: what they learned was saved straight away, so there is nothing to review. Calls never hung up
-- and past their time are closed at their limit.
update public.ai_role_calls set ended_at = started_at + interval '30 minutes' where ended_at is null and started_at < now() - interval '32 minutes';
update public.ai_role_calls set reviewed_at = coalesce(ended_at, now()) where reviewed_at is null;

-- The calls still to review, per person
create index if not exists ai_role_calls_to_review on public.ai_role_calls (profile_id, started_at desc) where reviewed_at is null;
-- The last call with an agent, per person (for picking up where it left off)
create index if not exists ai_role_calls_profile_role on public.ai_role_calls (profile_id, role_key, started_at desc);

-- People read their own calls (execs read every call, as before)
drop policy if exists "ai role calls: own read" on public.ai_role_calls;
create policy "ai role calls: own read" on public.ai_role_calls for select to authenticated using (profile_id = (select private.current_profile_id()));

-- A turn also stamps when the call was last talked in
create or replace function public.ai_role_call_add(p_id uuid, p_chars integer default 0, p_turns integer default 0, p_learned jsonb default '[]'::jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_role_calls
     set tts_characters = tts_characters + greatest(coalesce(p_chars, 0), 0),
         turns = turns + greatest(coalesce(p_turns, 0), 0),
         learned = learned || coalesce(p_learned, '[]'::jsonb),
         last_turn_at = case when coalesce(p_turns, 0) > 0 then now() else last_turn_at end
   where id = p_id;
$$;
revoke all on function public.ai_role_call_add(uuid, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.ai_role_call_add(uuid, integer, integer, jsonb) to service_role;

-- Reminders and tasks asked of an agent
create table if not exists public.agent_asks (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('reminder', 'task')),
  -- Who it's for (the person themselves for a reminder; the client's seat holder for a task)
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  asked_by    uuid not null references public.profiles(id) on delete cascade,
  role_key    text references public.ai_roles(key) on delete set null,
  call_id     uuid references public.ai_role_calls(id) on delete set null,
  client_id   uuid references public.clients(id) on delete cascade,
  title       text not null,
  detail      text not null default '',
  due_on      date,
  status      text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists agent_asks_owner on public.agent_asks (owner_id, status);
create index if not exists agent_asks_asker on public.agent_asks (asked_by, created_at desc);

alter table public.agent_asks enable row level security;
-- The owner and the person who asked read it (execs every one); the server writes them after its own checks
drop policy if exists "agent asks: read" on public.agent_asks;
create policy "agent asks: read" on public.agent_asks for select to authenticated
  using (owner_id = (select private.current_profile_id()) or asked_by = (select private.current_profile_id()) or (select private.is_exec()));
-- The owner marks it done or dismisses it
drop policy if exists "agent asks: owner updates" on public.agent_asks;
create policy "agent asks: owner updates" on public.agent_asks for update to authenticated
  using (owner_id = (select private.current_profile_id()))
  with check (owner_id = (select private.current_profile_id()));
