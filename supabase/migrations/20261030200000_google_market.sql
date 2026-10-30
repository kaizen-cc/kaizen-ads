create table if not exists public.google_market (
  id uuid primary key default gen_random_uuid(),
  vertical_id uuid not null references public.verticals(id) on delete cascade,
  kind text not null check (kind in ('search', 'competitor')),
  key text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (vertical_id, kind, key)
);
comment on table public.google_market is 'Google in the market, by sub-vertical: what people search (Keyword Planner: volume, 12-month trend, competition, top-of-page bids) and the competitors in our clients'' auctions (Auction Insights: impression share, overlap, outranking). Refreshed weekly';
alter table public.google_market enable row level security;
create policy "staff read google market" on public.google_market for select to authenticated using (private.is_staff());
