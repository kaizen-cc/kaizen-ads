-- Verticals and sub-verticals, worked out by the AI from everything known about our clients (intake, briefs, Brand
-- Bibles, go-to-market strategies), each sub-vertical with researched industry benchmarks for Meta.
create table public.verticals (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  name           text not null,
  parent_id      uuid references public.verticals(id) on delete cascade, -- null: a vertical; set: a sub-vertical
  description    text,
  conversion     text,            -- what counts as a result here: a lead, a purchase, a booking, a call…
  benchmarks     jsonb not null default '[]', -- [{ metric, good, great, unit, note, source, year }]
  benchmarks_at  timestamptz,
  active         boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now()
);
create index verticals_parent on public.verticals (parent_id);
alter table public.verticals enable row level security;
create policy "staff read verticals" on public.verticals for select to authenticated using (private.is_staff());

alter table public.clients
  add column if not exists vertical_id uuid references public.verticals(id) on delete set null, -- their sub-vertical
  add column if not exists vertical_why text,
  add column if not exists vertical_set_at timestamptz,
  add column if not exists meta_backfilled_at timestamptz; -- the 180-day ad history was pulled
alter table public.market_brands add column if not exists vertical_id uuid references public.verticals(id) on delete set null;

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('verticals', 'Vertical mapper', 'Works out the verticals and sub-verticals we serve from everything on each client page, places every client and market brand in one, and researches the Meta benchmarks for each sub-vertical.', 'opus', 'medium', true, 18, 'compass', '{}')
on conflict (key) do nothing;
