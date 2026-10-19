-- Handing an account to a new media buyer: when a client's Meta buyer changes (client page, Account Overview sheet,
-- team form) its KPI, open tickets and optimization sprint move to them, and the strategist writes them a handoff
-- (everything about the client up to now) with a chat to ask about the account. One row per change.
create table public.account_handoffs (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  from_id     uuid references public.profiles (id) on delete set null,
  to_id       uuid not null references public.profiles (id) on delete cascade,
  by_id       uuid references public.profiles (id) on delete set null,
  via         text not null default 'app' check (via in ('app', 'sheet', 'form')),
  moved       jsonb not null default '{}',
  status      text not null default 'writing' check (status in ('writing', 'ready', 'failed')),
  doc         jsonb,
  error       text,
  chat        jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  ready_at    timestamptz,
  seen_at     timestamptz
);
create index on public.account_handoffs (to_id, created_at desc);
create index on public.account_handoffs (client_id, created_at desc);
alter table public.account_handoffs enable row level security;
create policy "staff read handoffs for their clients" on public.account_handoffs for select to authenticated using (private.staff_can_see_client(client_id));
