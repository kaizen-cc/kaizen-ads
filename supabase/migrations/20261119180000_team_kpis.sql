-- Team KPI boards (Email Team KPIs: Design, Build, Copy, Strategy; Creative Team KPIs: Design, Video, Copy).
--  1. email_feedback: every comment on email work (the Asana email board's and the Email Board's own), credited to whoever
--     had the work then, and sorted once by a cheap AI pass into an objective error or not (the verdict is kept, so a
--     comment is read once). The boards read the errors per person.
--  2. email_score_days: each email client's account score once a day, so a strategist's accounts show a trend.
-- Read by execs and leads only (the people reading the boards); written by the server. Each policy checks access once
-- per query, never per row. Additive and idempotent.

create table if not exists public.email_feedback (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('asana', 'kaizen')),
  source_key text not null unique,
  profile_id uuid references public.profiles(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  ticket_number integer,
  asana_gid text,
  asana_url text,
  task_title text,
  area text not null default 'design' check (area in ('design', 'build', 'copy')),
  author text,
  quote text not null,
  at timestamptz not null,
  verdict text check (verdict in ('error', 'preference', 'unclear')),
  error_type text,
  classified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists email_feedback_person on public.email_feedback (profile_id, at desc);
create index if not exists email_feedback_todo on public.email_feedback (classified_at) where classified_at is null;
alter table public.email_feedback enable row level security;
drop policy if exists "leads read email feedback" on public.email_feedback;
create policy "leads read email feedback" on public.email_feedback for select to authenticated
  using ((select private.is_exec_or_lead()));

create table if not exists public.email_score_days (
  client_id uuid not null references public.clients(id) on delete cascade,
  day date not null,
  score integer not null check (score between 0 and 100),
  created_at timestamptz not null default now(),
  primary key (client_id, day)
);
alter table public.email_score_days enable row level security;
drop policy if exists "leads read email score days" on public.email_score_days;
create policy "leads read email score days" on public.email_score_days for select to authenticated
  using ((select private.is_exec_or_lead()));
