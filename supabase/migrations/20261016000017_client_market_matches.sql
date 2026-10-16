-- Each brand described on its own terms (what it sells, to whom), not borrowed from the client who named it
alter table public.market_brands add column if not exists described_at timestamptz;

-- Which market brands are genuinely comparable to each client, read from the client page (what they sell, who to,
-- how they sell, their strategy): competitors first, then lookalikes across industries, each with why
create table public.client_market_brands (
  client_id    uuid not null references public.clients(id) on delete cascade,
  brand_id     uuid not null references public.market_brands(id) on delete cascade,
  score        int not null,          -- 1 to 10, how comparable
  why          text,
  generated_at timestamptz not null default now(),
  primary key (client_id, brand_id)
);
create index client_market_brands_client on public.client_market_brands (client_id, score desc);
alter table public.client_market_brands enable row level security;
create policy "staff read client market brands" on public.client_market_brands for select to authenticated using (private.is_staff());

-- When each client's matches were last worked out
alter table public.clients add column if not exists market_matched_at timestamptz;
