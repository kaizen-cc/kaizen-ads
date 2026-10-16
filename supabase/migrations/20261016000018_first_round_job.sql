-- The first round as a tracked job: when the strategist started writing it, and why it failed if it did
alter table public.clients
  add column if not exists first_round_started_at timestamptz,
  add column if not exists first_round_error text;
