-- Where a client's ads belong, learned from the buyer: every time a launched ad is moved to another ad set (from Kaizen
-- Ads, or by hand in Ads Manager and explained after), the reason becomes a rule the launcher reads before placing that
-- client's next ads. Rules are turned off, never deleted.
create table if not exists public.launch_rules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  launch_id uuid references public.launches(id) on delete set null,
  rule text not null,
  from_adset jsonb,
  to_adset jsonb,
  via text not null default 'app' check (via in ('app', 'ads_manager')),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists launch_rules_client on public.launch_rules (client_id, created_at desc);
alter table public.launch_rules enable row level security;
create policy "staff read launch rules for their clients" on public.launch_rules for select to authenticated using (private.staff_can_see_client(client_id));

-- A launch's moves (from where to where, why, who), and an ad moved by hand in Ads Manager still waiting for the why
alter table public.launches add column if not exists moves jsonb not null default '[]', add column if not exists pending_move jsonb;
