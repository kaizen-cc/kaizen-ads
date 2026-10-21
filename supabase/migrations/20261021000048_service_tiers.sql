-- What each client buys. Kaizen Track's services stay the source (clients.services, mirrored hourly); services added
-- here for a client Track doesn't have (or doesn't have right yet) sit beside them in services_extra. Each service can
-- carry a tier: creative uses the creative packages (MVP, Basic, Silver, Gold); email, web, social and the rest use
-- service_tiers, defined by execs and leads as they're sold.
alter table public.clients add column if not exists services_extra text[] not null default '{}';

create table if not exists public.service_tiers (
  id uuid primary key default gen_random_uuid(),
  service text not null,
  label text not null,
  includes text,
  sort_order int not null default 100,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (service, label)
);
alter table public.service_tiers enable row level security;
create policy "staff read service tiers" on public.service_tiers for select to authenticated using (private.is_staff());
create policy "execs and leads write service tiers" on public.service_tiers for all to authenticated using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());

create table if not exists public.client_service_tiers (
  client_id uuid not null references public.clients(id) on delete cascade,
  service text not null,
  tier_id uuid references public.service_tiers(id) on delete set null,
  note text,
  set_by uuid references public.profiles(id) on delete set null,
  set_at timestamptz not null default now(),
  primary key (client_id, service)
);
alter table public.client_service_tiers enable row level security;
create policy "staff read client service tiers" on public.client_service_tiers for select to authenticated using (private.staff_can_see_client(client_id));
create policy "execs and leads write client service tiers" on public.client_service_tiers for all to authenticated using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());
