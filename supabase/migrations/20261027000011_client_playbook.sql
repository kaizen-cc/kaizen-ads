-- The client playbook: everything a client has run, kept forever with how it did. One row per creative (an ad), per
-- message angle, and per audience (an ad set), timestamped (first and last seen), with its numbers against the
-- client's KPI and a verdict (winner, loser, testing, inconclusive). Rows are never deleted; an ad turned off keeps
-- its row and its history. It feeds the Brand Bible's living learnings, every brief and suggestion, and new clients in
-- the same industry.
create table if not exists public.client_ledger (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  platform text not null default 'meta',
  kind text not null check (kind in ('creative', 'angle', 'audience')),
  key text not null, -- the ad id, the angle's name, the ad set id
  title text not null,
  detail jsonb not null default '{}', -- creative: text, headline, image, format, adset, campaign, angle, hook, avatar, offer; audience: name, targeting; angle: description
  first_seen date,
  last_seen date,
  live boolean not null default false,
  spend numeric not null default 0,
  results numeric not null default 0,
  revenue numeric not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost_per_result numeric,
  roas numeric,
  result_label text,
  target numeric,
  verdict text not null default 'testing' check (verdict in ('winner', 'loser', 'testing', 'inconclusive')),
  verdict_reason text,
  verdict_at timestamptz,
  ads int not null default 1, -- how many ads an angle or audience covers
  updated_at timestamptz not null default now(),
  unique (client_id, platform, kind, key)
);
create index if not exists client_ledger_client on public.client_ledger (client_id, kind, verdict);
alter table public.client_ledger enable row level security;
create policy "staff read their clients' playbook" on public.client_ledger for select to authenticated using (private.staff_can_see_client(client_id));

-- The Brand Bible keeps living: what the playbook taught, dated, added as it's learned (never rewritten away)
alter table public.client_brand_bibles add column if not exists learnings jsonb not null default '[]', add column if not exists learnings_at timestamptz;
