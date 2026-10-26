-- The launcher: a ticket's approved creative and copy pushed to Meta as paused ads. Each launch keeps its plan (the
-- ad set, names, Page, Instagram account, link, the structure Meta accepted), its checks, Meta's answers, and what was
-- created. Sandbox launches (Kaizen's own account) are tests: the ticket stays in Ready to launch.
create table if not exists public.launches (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  account text not null,
  sandbox boolean not null default false,
  status text not null default 'planning' check (status in ('planning', 'ready', 'blocked', 'launching', 'launched', 'failed', 'discarded')),
  progress text,
  plan jsonb,
  checks jsonb not null default '[]',
  result jsonb,
  error text,
  created_by uuid references public.profiles(id) on delete set null,
  launched_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  launched_at timestamptz
);
create index if not exists launches_request on public.launches (request_id, created_at desc);
alter table public.launches enable row level security;
create policy "staff read launches for their clients" on public.launches for select to authenticated using (private.staff_can_see_client(client_id));
-- Data (applied once): the launcher agent switched on, its playbook given the agreed launch rules and naming guidance.
