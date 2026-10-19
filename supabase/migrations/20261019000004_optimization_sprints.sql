-- Optimization sprints: an audit's plan, followed through with the buyer. A finished audit opens a sprint on that
-- account, assigned to its buyer (and watched by the exec or lead who ran it). Its actions are the buyer's to tick off.
-- Every day (and on the follow-up date it sets itself) the system re-reads the account, sees what changed in Meta and
-- what was ticked, and tells the buyer what it sees: a reminder, a warning that a change won't work and why, or that
-- it'll check back in a few days.

create table public.optimization_sprints (
  id            uuid primary key default gen_random_uuid(),
  target_id     uuid not null references public.kpi_targets (id) on delete cascade,
  client_id     uuid not null references public.clients (id) on delete cascade,
  audit_id      uuid references public.account_audits (id) on delete set null,
  buyer_id      uuid references public.profiles (id) on delete set null,
  watcher_ids   uuid[] not null default '{}',
  created_by    uuid references public.profiles (id) on delete set null,
  status        text not null default 'active' check (status in ('active', 'done', 'closed')),
  baseline      jsonb not null default '{}',   -- the KPI when it started: value, target, spend, results (14 days)
  latest        jsonb not null default '{}',   -- the KPI at the last check
  setup         jsonb,                         -- the live Meta setup at the last check, to see what the buyer changed
  last_check_at timestamptz,
  next_check_at timestamptz not null default now(),
  started_at    timestamptz not null default now(),
  closed_at     timestamptz,
  close_note    text
);
create index optimization_sprints_open on public.optimization_sprints (status, next_check_at) where status = 'active';
create index optimization_sprints_target on public.optimization_sprints (target_id, started_at desc);
-- One live sprint per KPI
create unique index optimization_sprints_one_active on public.optimization_sprints (target_id) where status = 'active';

create table public.sprint_actions (
  id           uuid primary key default gen_random_uuid(),
  sprint_id    uuid not null references public.optimization_sprints (id) on delete cascade,
  audit_index  int,                            -- which action of the audit's plan it came from
  title        text not null,
  area         text,
  owner        text,
  "when"       text,
  steps        jsonb not null default '[]',
  why          text,
  impact       text,
  status       text not null default 'todo' check (status in ('todo', 'doing', 'done', 'skipped')),
  note         text,
  ai_note      text,                           -- what the last check saw about this action
  done_by      uuid references public.profiles (id) on delete set null,
  done_at      timestamptz,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);
create index sprint_actions_sprint on public.sprint_actions (sprint_id, sort_order);

create table public.sprint_checks (
  id          uuid primary key default gen_random_uuid(),
  sprint_id   uuid not null references public.optimization_sprints (id) on delete cascade,
  verdict     text not null check (verdict in ('no_action', 'wrong_move', 'on_track', 'improving', 'worse', 'done', 'started')),
  message     text not null,                  -- to the buyer, first person
  changes     jsonb not null default '[]',    -- what changed in Meta since the last check
  kpi         jsonb not null default '{}',
  next_check_at timestamptz,
  created_at  timestamptz not null default now()
);
create index sprint_checks_sprint on public.sprint_checks (sprint_id, created_at desc);

alter table public.optimization_sprints enable row level security;
alter table public.sprint_actions enable row level security;
alter table public.sprint_checks enable row level security;
create policy "staff read sprints" on public.optimization_sprints for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff update sprints" on public.optimization_sprints for update to authenticated using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));
create policy "staff read sprint actions" on public.sprint_actions for select to authenticated
  using (exists (select 1 from public.optimization_sprints s where s.id = sprint_id and private.staff_can_see_client(s.client_id)));
create policy "staff work sprint actions" on public.sprint_actions for update to authenticated
  using (exists (select 1 from public.optimization_sprints s where s.id = sprint_id and private.staff_can_see_client(s.client_id)))
  with check (exists (select 1 from public.optimization_sprints s where s.id = sprint_id and private.staff_can_see_client(s.client_id)));
create policy "staff read sprint checks" on public.sprint_checks for select to authenticated
  using (exists (select 1 from public.optimization_sprints s where s.id = sprint_id and private.staff_can_see_client(s.client_id)));

-- The client-facing version of an audit (we-voice), written on request for the PDF
alter table public.account_audits add column client_report jsonb;
