-- The daily recap: what each person did with what it showed them. seen (it came up), saved (come back to it: their
-- list for the day, and a reminder tomorrow if it's still open), done (they acted), dismissed (not for them). The
-- items themselves are worked out fresh each time from the live data; this only remembers the person's side.
create table public.daily_items (
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  key         text not null,
  topic       text not null,
  client_id   uuid references public.clients (id) on delete cascade,
  snapshot    jsonb not null default '{}',
  status      text not null default 'seen' check (status in ('seen', 'saved', 'done', 'dismissed')),
  first_seen_at timestamptz not null default now(),
  saved_at    timestamptz,
  done_at     timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (profile_id, key)
);
create index on public.daily_items (profile_id, status);
alter table public.daily_items enable row level security;
create policy "own daily items" on public.daily_items for all to authenticated
  using (profile_id = private.current_profile_id()) with check (profile_id = private.current_profile_id());
