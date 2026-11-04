-- Kaizen AI phase 2: the Google policy checker and the monthly recap filled into the team's PowerPoint template.

-- One run of "Check everything" on a client's Google Ads account: every disapproved or limited ad, asset and keyword,
-- each with the exact trigger, Google's policy article, a landing page read, the fix, an appeal and how to ask for review.
create table if not exists public.policy_checks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  account text not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  issues jsonb not null default '[]'::jsonb,
  summary text,
  error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists policy_checks_client_idx on public.policy_checks (client_id, created_at desc);
alter table public.policy_checks enable row level security;
drop policy if exists "staff read policy checks" on public.policy_checks;
create policy "staff read policy checks" on public.policy_checks for select to authenticated using (private.is_staff());

-- Google policy articles read from support.google.com/adspolicy, kept a week (quoted and linked in every fix)
create table if not exists public.policy_articles (
  url text primary key,
  title text,
  body text not null default '',
  fetched_at timestamptz not null default now()
);
alter table public.policy_articles enable row level security;
drop policy if exists "staff read policy articles" on public.policy_articles;
create policy "staff read policy articles" on public.policy_articles for select to authenticated using (private.is_staff());

-- Where each piece of the recap goes in a template that has no {{placeholders}}: worked out once by the AI, per template
create table if not exists public.recap_template_maps (
  template_id text primary key,
  mapping jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.recap_template_maps enable row level security;
drop policy if exists "staff read recap template maps" on public.recap_template_maps;
create policy "staff read recap template maps" on public.recap_template_maps for select to authenticated using (private.is_staff());

-- The filled copy of the template for one monthly recap (one per report), in the client's Drive folder
create table if not exists public.recap_decks (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references public.reports(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  template_id text not null,
  presentation_id text,
  url text,
  status text not null default 'filling' check (status in ('filling', 'done', 'failed')),
  notes jsonb not null default '[]'::jsonb,
  error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recap_decks_client_idx on public.recap_decks (client_id, created_at desc);
alter table public.recap_decks enable row level security;
drop policy if exists "staff read recap decks" on public.recap_decks;
create policy "staff read recap decks" on public.recap_decks for select to authenticated using (private.is_staff());

-- The team's monthly recap template (a PowerPoint file in Drive; copies are converted to Google Slides to fill)
insert into public.app_settings (key, value)
values ('recap_template', '{"file_id": "1OKG7r8u3PEbiXZPG5b65vO1OpTdHx_Oz"}'::jsonb)
on conflict (key) do nothing;

-- Chart pictures for the deck: private, handed to Google Slides through short-lived signed links
insert into storage.buckets (id, name, public) values ('recap-charts', 'recap-charts', false) on conflict (id) do nothing;

-- A policy fix applied from the checker is logged in the change history like any other Google change
alter table public.ad_changes drop constraint if exists ad_changes_source_check;
alter table public.ad_changes add constraint ad_changes_source_check check (source = any (array['audit', 'sprint', 'chat', 'policy']));
