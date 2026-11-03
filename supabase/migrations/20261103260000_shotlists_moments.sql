-- Shot lists that reach the client every billing cycle, marked off as their files come in; inspiration from US brands
-- only; and each client's marketing moments, briefed ahead and judged after, so the winners come back next year.

-- Where a market brand advertises (US-only inspiration boards)
alter table market_brands add column if not exists country text;
alter table market_brands add column if not exists country_at timestamptz;

-- A shot list per billing cycle: written on its own for creative-package clients, shown in their portal, and each shot
-- marked delivered (with the files) as uploads and Drive files come in
alter table shot_lists add column if not exists cycle_start date;
alter table shot_lists add column if not exists auto boolean not null default false;
alter table shot_lists add column if not exists checked_at timestamptz;
create unique index if not exists shot_lists_auto_cycle on shot_lists (client_id, cycle_start) where auto;

-- Each client's marketing moments (holidays, seasons, industry days): briefed weeks ahead, judged after on the
-- profitability of the moment's campaign, and reused next year and for similar businesses
create table if not exists client_moments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  on_date date not null,
  lead_days int not null default 42,
  angle text,
  offer_idea text,
  why text,
  match_terms text[] not null default '{}', -- words that name the moment's campaign ("memorial", "bbq")
  status text not null default 'planned' check (status in ('planned', 'briefed', 'ran', 'won', 'lost', 'skipped')),
  suggestion_id uuid references creative_suggestions(id) on delete set null,
  result jsonb,
  vertical_id uuid references verticals(id) on delete set null,
  business_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, name, on_date)
);
create index if not exists client_moments_due on client_moments (status, on_date);
alter table client_moments enable row level security;
create policy "staff read moments" on client_moments for select to authenticated using (private.staff_can_see_client(client_id));

-- A brief for a marketing moment is its own kind of suggestion
alter table creative_suggestions drop constraint if exists creative_suggestions_kind_check;
alter table creative_suggestions add constraint creative_suggestions_kind_check check (kind = any (array['fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab', 'winner', 'refresh', 'onboarding', 'call', 'market', 'moment']));
