-- Briefs written in the background: asking for one (Brief more like this, a refresh for a tiring ad…) queues a job
-- that the server writes on its own, so a refresh or leaving the page doesn't lose it. The page shows its progress
-- against how long that kind of brief usually takes, and when it's ready a toast and a bell notification open it.
create table if not exists public.brief_jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('winner', 'refresh')),
  -- The AI call's label (ai_runs.label): how long it usually takes is read from there
  label         text not null,
  client_id     uuid references public.clients(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  -- What it's written from (the winning ad, the tiring ad), and a short name for the toast
  input         jsonb not null default '{}'::jsonb,
  title         text,
  status        text not null default 'queued' check (status in ('queued', 'writing', 'ready', 'failed')),
  suggestion_id uuid,
  error         text,
  expected_ms   int,
  attempts      int not null default 0,
  started_at    timestamptz,
  finished_at   timestamptz,
  seen_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists brief_jobs_profile on public.brief_jobs (profile_id, created_at desc);
create index if not exists brief_jobs_open on public.brief_jobs (status, created_at) where status in ('queued', 'writing');

alter table public.brief_jobs enable row level security;
-- Each person reads their own; the server (service role) writes them
drop policy if exists "brief jobs: own" on public.brief_jobs;
create policy "brief jobs: own" on public.brief_jobs for select to authenticated using (profile_id = auth.uid());
