-- Briefed over the allotment on purpose (owner, Nov 19 2026): a client already at or past its cap gets no drafted
-- briefs, but anyone can still brief them with a disclaimer. Each one is logged: who pushed it through, why (optional),
-- the pool and how far over it took the client, and what it became (tickets or Asana tasks).
create table if not exists public.allotment_overrides (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  pool text not null check (pool in ('images', 'videos')),
  cap int not null,
  used int not null,
  adds int not null,
  over_by int not null,
  reason text,
  title text,
  request_numbers int[] not null default '{}',
  asana_gids text[] not null default '{}',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists allotment_overrides_by_client on public.allotment_overrides (client_id, created_at desc);
alter table public.allotment_overrides enable row level security;
-- Execs and leads see every override; anyone sees their own
create policy "read allotment overrides" on public.allotment_overrides for select to authenticated
  using ((select private.is_exec_or_lead()) or created_by = (select private.current_profile_id()));
