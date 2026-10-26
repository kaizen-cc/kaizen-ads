-- Each person's daily review, as last built: the Overview shows it instantly (a refresh, signing in again) and
-- rebuilds it in the background, noting what changed since (handled, new). One row per person per New York day.
create table if not exists public.today_snapshots (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  data jsonb not null,
  delta jsonb,
  computed_at timestamptz not null default now(),
  primary key (profile_id, day)
);
alter table public.today_snapshots enable row level security;
create policy "own daily review" on public.today_snapshots for all to authenticated
  using (profile_id = private.current_profile_id()) with check (profile_id = private.current_profile_id());
