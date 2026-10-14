-- Kaizen Ads — Meta ad performance per client, pulled at 12pm and 6pm with the CommandCenter system user
create table public.meta_snapshots (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  ad_account_id text not null,
  date_start    date not null,
  date_stop     date not null,
  summary       jsonb not null,   -- last 30 days, account level
  weekly        jsonb not null,   -- the same, week by week
  ads           jsonb not null,   -- top ads by spend with their creative's headline and text
  fetched_at    timestamptz not null default now()
);
create index on public.meta_snapshots (client_id, fetched_at desc);
alter table public.meta_snapshots enable row level security;
create policy "staff read meta snapshots" on public.meta_snapshots for select to authenticated
  using (private.staff_can_see_client(client_id));
