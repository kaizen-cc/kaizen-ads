-- What the agents learn from the team, kept from piling up: every rebuttal, disagreement or override becomes one
-- conditional learning (what holds, under which condition, for which scope), consolidated nightly (duplicates merged,
-- contradictions resolved or put to an exec, stale ones retired) and fed to each call as the few that fit it.
-- And agent testing: real calls are sampled so a playbook change can be replayed and judged before it's saved.

create table if not exists public.agent_learnings (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null,
  source_table text not null,
  source_id uuid,
  client_id uuid references public.clients(id) on delete cascade,
  model text,
  vertical_id uuid references public.verticals(id) on delete set null,
  scope text not null default 'client' check (scope in ('client', 'vertical', 'model', 'everyone')),
  proposed_scope text check (proposed_scope in ('client', 'vertical', 'model', 'everyone')),
  kind text not null default 'lesson' check (kind in ('exception', 'lesson')),
  condition text,
  lesson text not null,
  confidence numeric not null default 0.5,
  evidence int not null default 1,
  evidence_clients uuid[] not null default '{}',
  sources jsonb not null default '[]',
  status text not null default 'active' check (status in ('active', 'merged', 'retired', 'conflict')),
  merged_into uuid references public.agent_learnings(id) on delete set null,
  conflict_with uuid references public.agent_learnings(id) on delete set null,
  note text,
  classified_at timestamptz,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
create index if not exists agent_learnings_pick on public.agent_learnings (agent_key, status, scope);
create index if not exists agent_learnings_client on public.agent_learnings (client_id) where client_id is not null;
create unique index if not exists agent_learnings_source on public.agent_learnings (source_table, source_id) where source_id is not null;
alter table public.agent_learnings enable row level security;
drop policy if exists "staff read agent learnings" on public.agent_learnings;
create policy "staff read agent learnings" on public.agent_learnings for select to authenticated using (private.is_staff());

-- A rolling sample of real calls per agent and place in the app (the last 30), replayed when a change is tested
create table if not exists public.agent_samples (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null,
  moment text not null,
  label text not null,
  system text not null,
  prompt text not null,
  schema jsonb not null,
  output text not null,
  model text not null,
  effort text not null,
  had_media boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists agent_samples_pick on public.agent_samples (agent_key, moment, created_at desc);
alter table public.agent_samples enable row level security;
drop policy if exists "staff read agent samples" on public.agent_samples;
create policy "staff read agent samples" on public.agent_samples for select to authenticated using (private.is_staff());

create or replace function public.trim_agent_samples() returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.agent_samples s using (
    select id from (select id, row_number() over (order by created_at desc) rn from public.agent_samples where agent_key = new.agent_key and moment = new.moment) x where x.rn > 30
  ) old where s.id = old.id;
  return null;
end $$;
drop trigger if exists agent_samples_trim on public.agent_samples;
create trigger agent_samples_trim after insert on public.agent_samples for each row execute function public.trim_agent_samples();

-- A test of a change: the replays side by side and the judge's verdicts
create table if not exists public.agent_evals (
  id uuid primary key default gen_random_uuid(),
  agent_key text,
  role_key text,
  kind text not null default 'change' check (kind in ('change', 'drift')),
  target text not null,
  proposal jsonb not null default '{}',
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  results jsonb not null default '[]',
  better int not null default 0,
  same int not null default 0,
  worse int not null default 0,
  summary text,
  error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  applied_at timestamptz
);
create index if not exists agent_evals_agent on public.agent_evals (agent_key, created_at desc);
create index if not exists agent_evals_role on public.agent_evals (role_key, created_at desc);
alter table public.agent_evals enable row level security;
drop policy if exists "staff read agent evals" on public.agent_evals;
create policy "staff read agent evals" on public.agent_evals for select to authenticated using (private.is_staff());

-- Every saved change to an agent, with who, when and the test it had (if any)
create table if not exists public.agent_changes (
  id uuid primary key default gen_random_uuid(),
  agent_key text,
  role_key text,
  target text not null,
  eval_id uuid references public.agent_evals(id) on delete set null,
  eval_summary text,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);
create index if not exists agent_changes_agent on public.agent_changes (agent_key, changed_at desc);
alter table public.agent_changes enable row level security;
drop policy if exists "staff read agent changes" on public.agent_changes;
create policy "staff read agent changes" on public.agent_changes for select to authenticated using (private.is_staff());

-- Backfill, without AI: every existing rebuttal, disagreement and override as a client-scoped lesson with no condition yet
-- (the nightly pass classifies them a few at a time)
insert into public.agent_learnings (agent_key, source_table, source_id, client_id, lesson, evidence_clients, sources, created_at, last_seen)
select 'creativereview', 'creative_review_disagreements', d.id, d.client_id,
  left(format('Don''t raise%s: "%s"%s', coalesce(' (' || d.area || ')', ''), d.note, coalesce(' · the team: ' || d.reason, '')), 800),
  array[d.client_id], jsonb_build_array(jsonb_build_object('table', 'creative_review_disagreements', 'id', d.id)), d.created_at, d.created_at
from public.creative_review_disagreements d where d.client_id is not null
on conflict do nothing;
insert into public.agent_learnings (agent_key, source_table, source_id, client_id, lesson, evidence_clients, sources, created_at, last_seen)
select 'auditor', 'audit_rebuttals', r.id, r.client_id,
  left(format('Finding pushed back on: "%s" · why: %s', r.finding, r.reason), 800),
  array[r.client_id], jsonb_build_array(jsonb_build_object('table', 'audit_rebuttals', 'id', r.id)), r.created_at, r.created_at
from public.audit_rebuttals r
on conflict do nothing;
insert into public.agent_learnings (agent_key, source_table, source_id, client_id, lesson, evidence_clients, sources, created_at, last_seen)
select 'copy', 'copy_rule_overrides', o.id, o.client_id,
  left(format('Rule read too strictly%s: "%s"%s · why: %s', case when o.kind = 'force' then ' (approved past it)' else '' end, o.rule, coalesce(' on "' || o.quote || '"', ''), o.reason), 800),
  array[o.client_id], jsonb_build_array(jsonb_build_object('table', 'copy_rule_overrides', 'id', o.id)), o.created_at, o.created_at
from public.copy_rule_overrides o where o.client_id is not null
on conflict do nothing;
