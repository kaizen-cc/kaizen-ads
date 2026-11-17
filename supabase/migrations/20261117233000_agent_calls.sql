-- Calling an AI agent by voice. Each agent gets a voice (picked on its page; empty = its role's default voice). Each
-- call is one row: who called which agent, when, how it listened (ElevenLabs realtime or the browser's own), what it
-- cost (ElevenLabs characters spoken, seconds listened) and what it learned (items saved to its skills, kept so the
-- hang-up summary can undo each one) or sent to its chat as proposed edits. What was said is kept in the agent's chat
-- (ai_role_chats, tagged with the call), so it reads like any other conversation with it. ai_runs gets the ElevenLabs
-- characters too, so a call's cost sits with the other AI runs.

alter table public.ai_roles add column if not exists voice_id text;

alter table public.ai_runs
  add column if not exists characters integer not null default 0,
  add column if not exists audio_seconds integer not null default 0;

create table if not exists public.ai_role_calls (
  id              uuid primary key default gen_random_uuid(),
  role_key        text not null references public.ai_roles(key) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  voice_id        text,
  -- How the call listened: ElevenLabs realtime speech to text, or the browser's own speech recognition
  stt             text check (stt in ('scribe', 'browser')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  turns           integer not null default 0,
  tts_characters  integer not null default 0,
  stt_seconds     integer not null default 0,
  -- [{id, type, skill, title, body, undone}]: notes saved to the agent's skills (id = the ai_knowledge item) and
  -- rewrites of its core or a skill's instructions (id null), sent to its chat as proposals at hang-up
  learned         jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists ai_role_calls_role on public.ai_role_calls (role_key, started_at desc);
create index if not exists ai_role_calls_profile on public.ai_role_calls (profile_id, started_at desc);

alter table public.ai_role_calls enable row level security;
-- Executives read them; the server (service role) writes them after checking who may call the agent
drop policy if exists "ai role calls: execs read" on public.ai_role_calls;
create policy "ai role calls: execs read" on public.ai_role_calls for select to authenticated using ((select private.is_exec()));

-- The call a chat message was said in (null for typed messages)
alter table public.ai_role_chats add column if not exists call_id uuid references public.ai_role_calls(id) on delete set null;
create index if not exists ai_role_chats_call on public.ai_role_chats (call_id) where call_id is not null;

-- Adds to a call's running totals in one step (sentences are spoken in parallel, so no read-then-write)
create or replace function public.ai_role_call_add(p_id uuid, p_chars integer default 0, p_turns integer default 0, p_learned jsonb default '[]'::jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_role_calls
     set tts_characters = tts_characters + greatest(coalesce(p_chars, 0), 0),
         turns = turns + greatest(coalesce(p_turns, 0), 0),
         learned = learned || coalesce(p_learned, '[]'::jsonb)
   where id = p_id;
$$;
revoke all on function public.ai_role_call_add(uuid, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.ai_role_call_add(uuid, integer, integer, jsonb) to service_role;
