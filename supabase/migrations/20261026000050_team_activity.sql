-- How the team uses Kaizen Ads, for execs: when each person last signed in and was last active, minutes active per day
-- (a heartbeat while a tab is open and in use), and a log of what they opened. With the ticket history (request_events)
-- and reports sent, it's the activity log on the Team page. Recorded through activity_beat() and activity_log() only
-- (applied via MCP; see the database for their bodies). last_sign_in_at was backfilled from auth.users.
alter table public.profiles add column if not exists last_active_at timestamptz, add column if not exists last_sign_in_at timestamptz;

create table if not exists public.activity_minutes (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  minutes int not null default 0,
  last_beat_at timestamptz,
  primary key (profile_id, day)
);
alter table public.activity_minutes enable row level security;
create policy "execs read activity minutes" on public.activity_minutes for select to authenticated using (private.is_exec() or profile_id = private.current_profile_id());

create table if not exists public.activity_events (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in ('sign_in', 'page')),
  path text,
  label text
);
create index if not exists activity_events_profile_at on public.activity_events (profile_id, at desc);
alter table public.activity_events enable row level security;
create policy "execs read activity" on public.activity_events for select to authenticated using (private.is_exec());
