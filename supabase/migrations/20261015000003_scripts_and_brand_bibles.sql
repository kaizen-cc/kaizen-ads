-- Kaizen Ads — Video script writer and Brand bible builder agents
-- Scripts: one per video ticket, written on request from the ticket. Brand bibles: one per client, researched
-- on the web and compiled from everything the app knows; once the head of creative marks it reviewed, its
-- "Read this first" slice feeds the brief strategist, copywriter and reviewer.

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('scripts', 'Video script writer', 'Writes the script for a video ticket: three hooks, the framework, a timed beat sheet with visuals, voiceover and on-screen text, filming notes for whoever shoots it, and what to test.', 'opus', 'medium', true, 7, 'film', '{}'),
  ('brandbible', 'Brand bible builder', 'Researches a client (website, reviews, competitors, market) and builds their Brand Bible: audience profiles, voice, claims, review bank, look, competitors and calendar. Every other agent works from it once it''s reviewed.', 'opus', 'high', true, 8, 'book', '{}')
on conflict (key) do nothing;

-- ─── Scripts ────────────────────────────────────────────────────────────────

create table public.request_scripts (
  request_id    uuid primary key references public.requests(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  content       jsonb not null,
  model         text,
  version       int not null default 1,
  generated_by  uuid references public.profiles(id) on delete set null,
  generated_at  timestamptz not null default now()
);
create index on public.request_scripts (client_id);
alter table public.request_scripts enable row level security;
create policy "staff read scripts" on public.request_scripts for select to authenticated using (private.staff_can_see_client(client_id));
-- Written by the server after the AI call

-- ─── Brand bibles ───────────────────────────────────────────────────────────

create table public.client_brand_bibles (
  client_id        uuid primary key references public.clients(id) on delete cascade,
  status           text not null default 'building' check (status in ('building', 'draft', 'reviewed', 'failed')),
  version          text not null default 'v1.0',
  markdown         text not null default '',
  read_this_first  text not null default '',
  team_notes       jsonb not null default '[]',
  open_questions   jsonb not null default '[]',
  research         text not null default '',
  sources_pasted   text not null default '',
  error            text,
  started_at       timestamptz,
  generated_at     timestamptz,
  generated_by     uuid references public.profiles(id) on delete set null,
  reviewed_at      timestamptz,
  reviewed_by      uuid references public.profiles(id) on delete set null
);
alter table public.client_brand_bibles enable row level security;
create policy "staff read brand bibles" on public.client_brand_bibles for select to authenticated using (private.staff_can_see_client(client_id));
-- Marking it reviewed: execs and leads (the head of creative)
create policy "leads review brand bibles" on public.client_brand_bibles for update to authenticated
  using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());
