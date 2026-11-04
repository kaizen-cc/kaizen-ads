-- Creative KPIs, round two: Asana comments kept with each task (the team's and the client's feedback, read for real
-- errors), every feedback item sorted into an objective error or a preference, and a client's allotment dismissed for
-- one billing cycle by an exec or lead (with why), which also keeps that cycle out of the "nothing made" alerts.

alter table public.asana_tasks add column if not exists comments jsonb not null default '[]'::jsonb;
-- Read each recent task's stories again so its comments fill in (a batch per sync)
update public.asana_tasks set history_read_at = null where asana_modified_at > now() - interval '100 days';

create table if not exists public.creative_feedback (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('review', 'asana')),
  source_key text not null unique,
  profile_id uuid references public.profiles(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  request_number integer,
  asana_gid text,
  asana_url text,
  task_title text,
  round text check (round in ('internal', 'client')),
  author text,
  quote text not null,
  at timestamptz not null,
  verdict text check (verdict in ('error', 'preference', 'unclear')),
  error_type text,
  classified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists creative_feedback_person on public.creative_feedback (profile_id, at desc);
create index if not exists creative_feedback_todo on public.creative_feedback (classified_at) where classified_at is null;
alter table public.creative_feedback enable row level security;
drop policy if exists "staff read creative feedback" on public.creative_feedback;
create policy "staff read creative feedback" on public.creative_feedback for select to authenticated using (private.is_staff());

create table if not exists public.allotment_dismissals (
  client_id uuid not null references public.clients(id) on delete cascade,
  period_start date not null,
  reason text,
  dismissed_by uuid references public.profiles(id) on delete set null,
  dismissed_at timestamptz not null default now(),
  primary key (client_id, period_start)
);
alter table public.allotment_dismissals enable row level security;
drop policy if exists "staff read allotment dismissals" on public.allotment_dismissals;
create policy "staff read allotment dismissals" on public.allotment_dismissals for select to authenticated using (private.is_staff());
