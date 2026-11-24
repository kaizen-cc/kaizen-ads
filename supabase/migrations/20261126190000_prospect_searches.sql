-- Prospect searches as background jobs (owner, Nov 24 2026): "find businesses like…" runs on its own, not tied to the
-- page, so a refresh, another page or a closed tab never loses it. Stages: searching sources → checking sites → scoring
-- fit → saving, with a percentage and "N businesses found so far"; it can be cancelled. When it's done the person gets a
-- bell (and a toast wherever they are in the OS) and a Needs me item to review what was found, cleared once they've
-- opened the results or acted on every one. Started from the Sales page, the assistant or the Sales agent alike.

create table if not exists public.prospect_searches (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  profile       text not null,
  want          integer not null default 8,
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  stage         text check (stage in ('searching', 'checking', 'scoring', 'saving')),
  progress      integer not null default 0 check (progress between 0 and 100),
  found         integer not null default 0,
  added         integer not null default 0,
  results       jsonb not null default '[]'::jsonb,
  error         text,
  cancel        boolean not null default false,
  attempts      integer not null default 0,
  reviewed_at   timestamptz,
  started_via   text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  stage_at      timestamptz,
  finished_at   timestamptz
);
create index if not exists prospect_searches_mine on public.prospect_searches (profile_id, created_at desc);
create index if not exists prospect_searches_open on public.prospect_searches (status, created_at) where status in ('queued', 'running');
alter table public.prospect_searches enable row level security;
drop policy if exists "own prospect searches" on public.prospect_searches;
create policy "own prospect searches" on public.prospect_searches for select to authenticated
  using (profile_id = (select private.current_profile_id()) or (select private.is_exec()));
drop policy if exists "cancel or review own prospect searches" on public.prospect_searches;
create policy "cancel or review own prospect searches" on public.prospect_searches for update to authenticated
  using (profile_id = (select private.current_profile_id())) with check (profile_id = (select private.current_profile_id()));
grant select, update on public.prospect_searches to authenticated;
