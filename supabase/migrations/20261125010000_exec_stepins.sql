-- The executives' weekly step-ins (src/lib/stepins): one living card per client that needs an exec (a fire, an ad
-- account 50%+ off for 7+ days with nothing in motion, email red all week with nothing moving, items stuck past the
-- lead). Every exec shares the same card: its comments live in item_comments (key stepin:<client_id>), who's handling
-- it and by when live here. Built Monday morning, refreshed each morning; closes when the account recovers or an exec
-- marks it handled, reopens if it slides again. Executives only; written by the server after the check.

create table if not exists public.exec_stepins (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null unique references public.clients(id) on delete cascade,
  status        text not null default 'open' check (status in ('open', 'handled', 'recovered')),
  reasons       jsonb not null default '[]'::jsonb,
  card          jsonb not null default '{}'::jsonb,
  lines         text[] not null default '{}',
  fire          boolean not null default false,
  severity      integer not null default 0,
  week_start    date not null,
  handler_id    uuid references public.profiles(id),
  due_on        date,
  handled_by    uuid references public.profiles(id),
  handled_at    timestamptz,
  handled_note  text,
  opened_at     timestamptz not null default now(),
  reopened_at   timestamptz,
  closed_at     timestamptz,
  last_seen_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists exec_stepins_status on public.exec_stepins (status, severity desc);
alter table public.exec_stepins enable row level security;
drop policy if exists "execs read step-ins" on public.exec_stepins;
create policy "execs read step-ins" on public.exec_stepins for select to authenticated using ((select private.is_exec()));
