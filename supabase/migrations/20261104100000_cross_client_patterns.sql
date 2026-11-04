-- Patterns across clients: what works (or fails) for a whole group of businesses (every restaurant, every roofer),
-- from proven evidence across Kaizen's accounts. Client names never appear in a pattern's words; which clients use it
-- and which don't yet are kept as ids, for the team.
create table if not exists public.client_patterns (
  id uuid primary key default gen_random_uuid(),
  model text not null, -- the business model: ecommerce, restaurant, bookings, local_service, lead_gen
  vertical_id uuid references public.verticals(id) on delete set null, -- a sub-vertical, or null for the whole model
  group_label text not null, -- "Restaurants", "Roofing"
  kind text not null check (kind in ('angle', 'concept', 'offer', 'format', 'audience', 'moment', 'google')),
  verdict text not null check (verdict in ('works', 'fails')),
  title text not null,
  detail text not null default '',
  evidence jsonb not null default '{}'::jsonb, -- { clients, of, items: ["…"] }
  confidence text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  using_ids uuid[] not null default '{}',
  missing_ids uuid[] not null default '{}', -- clients in the group not using it yet: the opportunities
  generated_at timestamptz not null default now()
);
create index if not exists client_patterns_group on public.client_patterns (model, vertical_id);
alter table public.client_patterns enable row level security;
create policy "staff read patterns" on public.client_patterns for select to authenticated using (private.is_staff());

-- A brief written from a pattern is its own kind of suggestion
alter table public.creative_suggestions drop constraint if exists creative_suggestions_kind_check;
alter table public.creative_suggestions add constraint creative_suggestions_kind_check check (kind = any (array['fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab', 'winner', 'refresh', 'onboarding', 'call', 'market', 'moment', 'pattern']));
