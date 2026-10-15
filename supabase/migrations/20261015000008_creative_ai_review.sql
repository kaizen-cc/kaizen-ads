-- Kaizen Ads — the AI's notes for creative review
-- When a ticket reaches creative review, the AI looks at every uploaded file against the brief, the client's brand
-- bible and memory, and Meta's placements, and leaves notes for the reviewer: what to fix, what to keep an eye on,
-- what works. One row per ticket; `signature` is the design versions it looked at, so a re-upload means a new look.

create table public.creative_ai_reviews (
  request_id  uuid primary key references public.requests(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  signature   text not null default '',
  status      text not null default 'running' check (status in ('running', 'done', 'failed')),
  content     jsonb,
  model       text,
  error       text,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.creative_ai_reviews enable row level security;
-- Written by the server; the team reads it
create policy "staff read creative ai reviews" on public.creative_ai_reviews for select to authenticated
  using (private.staff_can_see_client(client_id));

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('creativereview', 'Creative reviewer', 'Looks over the creative when it reaches creative review: typos, offer and price against the brief, brand rules and what the client asked us to avoid, Meta safe zones and legibility, sizes that crop badly, and policy risks. Leaves notes for whoever reviews it.', 'opus', 'medium', true, 10, 'scan', '{}')
on conflict (key) do nothing;
