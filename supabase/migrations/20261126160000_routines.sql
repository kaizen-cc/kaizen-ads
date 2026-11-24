-- Per-person routines (owner, Nov 24 2026): the OS does what an exec's Claude scheduled runs did, inside Kaizen OS.
-- A routine is one kind of run for one person at their chosen times (recaps, the debrief sweep, the delegation tracker,
-- the nightly agent, the morning clean sweep, the week recap and week-ahead prep, call prep). Each run's report lives
-- in routine_runs (the person's recaps page, the bell); items it makes are OS items (agent_asks), deduped against reality.

create table if not exists public.routines (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  enabled boolean not null default false,
  times text[] not null default '{}',
  days text not null default 'weekdays' check (days in ('weekdays', 'daily', 'fri', 'sun')),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (profile_id, kind)
);

create table if not exists public.routine_runs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  run_key text not null unique,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  headline text,
  report jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists routine_runs_profile_idx on public.routine_runs (profile_id, started_at desc);

alter table public.routines enable row level security;
alter table public.routine_runs enable row level security;
drop policy if exists routines_own on public.routines;
create policy routines_own on public.routines for all using (profile_id = (select private.current_profile_id())) with check (profile_id = (select private.current_profile_id()));
drop policy if exists routine_runs_own on public.routine_runs;
create policy routine_runs_own on public.routine_runs for select using (profile_id = (select private.current_profile_id()));

-- Items the nightly agent stages for release (never assigned until the person releases them), and a message drafted on
-- an item for one-tap send
alter table public.agent_asks drop constraint if exists agent_asks_status_check;
alter table public.agent_asks add constraint agent_asks_status_check check (status in ('open', 'done', 'dismissed', 'staged'));
alter table public.agent_asks add column if not exists draft jsonb, add column if not exists released_at timestamptz, add column if not exists staged_for uuid references public.profiles(id);
