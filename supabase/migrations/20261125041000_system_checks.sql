-- One-time production checks the server runs on its own (calendar scheduling end to end): what ran, when, and each
-- step's outcome. Server only.
create table if not exists public.system_checks (
  key text primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  result jsonb not null default '{}'::jsonb
);
alter table public.system_checks enable row level security;
