-- Call my assistant.
-- 1. A personal assistant agent (ai_roles key 'assistant') everyone can call from the side menu. It has no skills and
--    nobody trains it; it acts in the app with the caller's own rights. Its calls and chat rows are the caller's own:
--    execs no longer read them through the shared policies (only through the safety review, below).
-- 2. A call can have a specialist on the line with the assistant (guest_role), keeps call notes (decisions and
--    follow-ups), what was uploaded during it (uploads), the Kaizen AI thread its cards live in (thread_id) and how
--    many audio parts were recorded.
-- 3. A personal memory per person (assistant_memory): facts they shared and their style. Private to that person:
--    only they read, edit or delete it. Never readable by execs, never part of any agent's shared knowledge.
-- 4. The one-time notice that calls are recorded and may be reviewed (call_notice_acks), acknowledged with its time.
-- 5. The safety review after each call (call_safety_reviews): execs only. Call audio lives in a private bucket
--    (call-audio): unflagged audio is deleted right after the review, flagged audio is kept about 90 days.

insert into public.ai_roles (key, label, description, icon, core, sort_order)
values ('assistant', 'Assistant', 'Your personal assistant: knows your day, your clients and your work, and gets things done in the app with your own rights.', 'spark', '', 999)
on conflict (key) do nothing;

alter table public.ai_role_calls
  add column if not exists guest_role text references public.ai_roles(key) on delete set null,
  add column if not exists notes jsonb,
  add column if not exists uploads jsonb not null default '[]'::jsonb,
  add column if not exists thread_id uuid references public.ai_threads(id) on delete set null,
  add column if not exists audio_parts integer not null default 0,
  -- Things the assistant started and tells the person about when they're ready: [{ kind: 'report', id, client, done }]
  add column if not exists watches jsonb not null default '[]'::jsonb,
  add column if not exists safety_reviewed_at timestamptz;

-- Calls whose safety review hasn't run yet (the cron picks them up)
create index if not exists ai_role_calls_safety_todo on public.ai_role_calls (ended_at) where safety_reviewed_at is null and ended_at is not null;

-- Assistant calls are private to the caller: the execs' shared read leaves them out
drop policy if exists "ai role calls: execs read" on public.ai_role_calls;
create policy "ai role calls: execs read" on public.ai_role_calls for select to authenticated
  using ((select private.is_exec()) and role_key <> 'assistant');

drop policy if exists "execs use role chats" on public.ai_role_chats;
create policy "execs use role chats" on public.ai_role_chats for all to authenticated
  using ((select private.is_exec()) and role_key <> 'assistant')
  with check ((select private.is_exec()) and role_key <> 'assistant');
drop policy if exists "role chats: own assistant read" on public.ai_role_chats;
create policy "role chats: own assistant read" on public.ai_role_chats for select to authenticated
  using (role_key = 'assistant' and created_by = (select private.current_profile_id()));

-- ─── Personal memory ────────────────────────────────────────────────────────
create table if not exists public.assistant_memory (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  -- fact: something they told the assistant; style: how they like to talk (one row per trait)
  kind         text not null check (kind in ('fact', 'style')),
  -- fact: birthday, family, trip, preference, work, other; style: length, humor, numbers, pace, other
  topic        text not null default 'other',
  body         text not null check (char_length(body) between 2 and 600),
  -- A day it matters (a birthday: month and day are what count; a trip's return)
  on_date      date,
  -- Ask about it on or after this day ("how was the trip?"), once
  follow_up_on date,
  followed_up_at timestamptz,
  call_id      uuid references public.ai_role_calls(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists assistant_memory_owner on public.assistant_memory (profile_id, kind, updated_at desc);
create unique index if not exists assistant_memory_style_one on public.assistant_memory (profile_id, topic) where kind = 'style';

alter table public.assistant_memory enable row level security;
-- Only the person: no exec policy, on purpose
drop policy if exists "assistant memory: own read" on public.assistant_memory;
create policy "assistant memory: own read" on public.assistant_memory for select to authenticated
  using (profile_id = (select private.current_profile_id()));
drop policy if exists "assistant memory: own insert" on public.assistant_memory;
create policy "assistant memory: own insert" on public.assistant_memory for insert to authenticated
  with check (profile_id = (select private.current_profile_id()));
drop policy if exists "assistant memory: own update" on public.assistant_memory;
create policy "assistant memory: own update" on public.assistant_memory for update to authenticated
  using (profile_id = (select private.current_profile_id()))
  with check (profile_id = (select private.current_profile_id()));
drop policy if exists "assistant memory: own delete" on public.assistant_memory;
create policy "assistant memory: own delete" on public.assistant_memory for delete to authenticated
  using (profile_id = (select private.current_profile_id()));

-- ─── The recording notice ───────────────────────────────────────────────────
create table if not exists public.call_notice_acks (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  version     integer not null default 1,
  acked_at    timestamptz not null default now()
);
alter table public.call_notice_acks enable row level security;
drop policy if exists "call notice: own read" on public.call_notice_acks;
create policy "call notice: own read" on public.call_notice_acks for select to authenticated
  using (profile_id = (select private.current_profile_id()) or (select private.is_exec()));

-- ─── The safety review ──────────────────────────────────────────────────────
create table if not exists public.call_safety_reviews (
  call_id            uuid primary key references public.ai_role_calls(id) on delete cascade,
  profile_id         uuid not null references public.profiles(id) on delete cascade,
  flagged            boolean not null default false,
  categories         text[] not null default '{}',
  severity           text check (severity is null or severity in ('low', 'medium', 'high')),
  summary            text,
  -- [{ at_seconds, category, note }] where to skip to in the transcript and audio
  moments            jsonb not null default '[]'::jsonb,
  distress           boolean not null default false,
  reviewed_at        timestamptz not null default now(),
  audio_delete_after timestamptz,
  audio_deleted_at   timestamptz,
  seen_by            uuid references public.profiles(id) on delete set null,
  seen_at            timestamptz
);
create index if not exists call_safety_flagged on public.call_safety_reviews (reviewed_at desc) where flagged;
create index if not exists call_safety_audio_due on public.call_safety_reviews (audio_delete_after) where audio_deleted_at is null;

alter table public.call_safety_reviews enable row level security;
drop policy if exists "call safety: execs read" on public.call_safety_reviews;
create policy "call safety: execs read" on public.call_safety_reviews for select to authenticated
  using ((select private.is_exec()));

-- Call audio: private, server only (signed upload links for the caller's own call; execs listen through signed links)
insert into storage.buckets (id, name, public, file_size_limit) values ('call-audio', 'call-audio', false, 52428800) on conflict (id) do nothing;
