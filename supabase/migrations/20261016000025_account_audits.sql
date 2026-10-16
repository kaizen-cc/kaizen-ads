-- The AI account audit, from the KPI board: one ad account (a KPI target) scrubbed against its target, its own
-- history, the client's context, what wins in its sub-vertical, the benchmarks and the market. Kept as history; the
-- action items are ticked off by the buyer.
create table public.account_audits (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.kpi_targets (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'ready', 'failed')),
  step text,                                  -- what it's doing now, for the progress bar
  progress int not null default 0,
  result jsonb,                               -- verdict, diagnosis, findings, actions, tests, creative, questions
  done jsonb not null default '{}',           -- action index → { by, at }
  inputs jsonb not null default '{}',         -- what it read (counts), for the footer
  error text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index account_audits_target on public.account_audits (target_id, created_at desc);
alter table public.account_audits enable row level security;
create policy "staff read audits" on public.account_audits for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff tick audit actions" on public.account_audits for update to authenticated using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));

insert into public.ai_agents (key, label, description, model, effort, icon, sort_order)
select 'auditor', 'Account auditor',
  'Scrubs one ad account against its KPI target and writes a real audit: why it''s under or over, what to change in structure, audiences, budget and bidding, creative and the funnel, and the tests the buyer should run.',
  'opus', 'high', 'scan', 19
where not exists (select 1 from public.ai_agents where key = 'auditor');
