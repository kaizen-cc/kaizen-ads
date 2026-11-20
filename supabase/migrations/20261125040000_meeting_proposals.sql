-- Times the assistant offered for an internal call (find_meeting_time): who, how long, the window looked at, and the
-- starts shown so far (More times shows the next batch). A tap on a slot card or a spoken yes books it once; the
-- other then shows it booked. Read by the person; written only by the server.
create table if not exists public.meeting_proposals (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  call_id uuid,
  attendee_ids uuid[] not null default '{}',
  minutes int not null default 30,
  title text,
  agenda text,
  timezone text not null default 'America/New_York',
  from_day date not null,
  to_day date not null,
  earliest int,
  latest int,
  shown text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'booked')),
  meeting_id uuid references public.assistant_meetings(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meeting_proposals_profile_idx on public.meeting_proposals (profile_id, created_at desc);

alter table public.meeting_proposals enable row level security;
drop policy if exists "own meeting proposals" on public.meeting_proposals;
create policy "own meeting proposals" on public.meeting_proposals for select to authenticated
  using (profile_id = (select private.current_profile_id()));
