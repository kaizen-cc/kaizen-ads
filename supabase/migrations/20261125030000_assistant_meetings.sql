-- Internal calls the assistant (or an agent, or Kaizen AI) booked on someone's calendar, as them, on their yes: the
-- Google event, who's on it, when, and what happened since (moved, cancelled). Read by the person who booked it;
-- written only by the server.
create table if not exists public.assistant_meetings (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  google_event_id text not null,
  calendar_link text,
  meet_link text,
  title text not null,
  agenda text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'America/New_York',
  attendees jsonb not null default '[]'::jsonb,
  status text not null default 'booked' check (status in ('booked', 'moved', 'cancelled')),
  booked_via text not null default 'assistant',
  call_id uuid,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, google_event_id)
);
create index if not exists assistant_meetings_profile_idx on public.assistant_meetings (profile_id, starts_at desc);

alter table public.assistant_meetings enable row level security;
drop policy if exists "own booked meetings" on public.assistant_meetings;
create policy "own booked meetings" on public.assistant_meetings for select to authenticated
  using (profile_id = (select private.current_profile_id()));
