-- Keyword research in Ideas › Google › In the market: Keyword Planner results per client and seeds, kept 24 hours
-- (Basic access allows 15,000 operations a day, and the relevance pass costs an AI call), and each client's saved
-- keyword lists ("BBQ season", "Brunch") to come back to and add to their Google Ads account.

create table if not exists public.keyword_research_cache (
  key text primary key,
  client_id uuid references public.clients(id) on delete cascade,
  result jsonb not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists keyword_research_cache_by on public.keyword_research_cache (created_by, created_at desc);
alter table public.keyword_research_cache enable row level security;
-- Read and written by the server only

create table if not exists public.client_keyword_lists (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  -- [{ text, match: exact|phrase|broad, negative, searches, competition, bidLow, bidHigh, theme }]
  keywords jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists client_keyword_lists_client on public.client_keyword_lists (client_id, updated_at desc);
alter table public.client_keyword_lists enable row level security;
drop policy if exists "staff read keyword lists" on public.client_keyword_lists;
create policy "staff read keyword lists" on public.client_keyword_lists for select to authenticated using (private.staff_can_see_client(client_id));
