-- The Ads Lab, for execs and leads: a round table with the AI agents, a library of material to think with (briefs,
-- skills, call transcripts, videos, articles), and tests run on chosen clients. A test that wins becomes a learning
-- deployed into the memory of every client it fits; one that flops is talked through and iterated.

create table public.lab_sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('doc', 'transcript', 'video', 'link', 'skill', 'note')),
  title text not null,
  url text,
  body text not null default '', -- the text itself, or what the AI read from the link
  summary text, -- the AI's takeaways, short
  status text not null default 'ready' check (status in ('reading', 'ready', 'failed')),
  added_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.lab_threads (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New conversation',
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.lab_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.lab_threads (id) on delete cascade,
  role text not null check (role in ('user', 'agent')),
  agent text, -- which seat at the table spoke
  author_id uuid references public.profiles (id),
  body text not null,
  data jsonb, -- tests the table proposed with this message
  created_at timestamptz not null default now()
);
create index lab_messages_by on public.lab_messages (thread_id, created_at);

create table public.lab_tests (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references public.lab_threads (id) on delete set null,
  parent_id uuid references public.lab_tests (id) on delete set null, -- the test this one iterates on
  title text not null,
  hypothesis text not null,
  change text not null, -- what the creative does differently
  metric text not null default 'cpr' check (metric in ('cpr', 'results', 'ctr', 'roas')),
  success text not null, -- what counts as a win, in words
  target_lift numeric not null default 0.15, -- e.g. 0.15 = 15% better than baseline
  status text not null default 'proposed' check (status in ('proposed', 'running', 'won', 'lost', 'dropped')),
  client_ids uuid[] not null default '{}',
  baseline jsonb not null default '{}', -- per client: { spend, results, cpr } over the 14 days before
  result jsonb not null default '{}', -- per client, when it was read
  started_at timestamptz,
  ends_at timestamptz,
  verdict_note text,
  learning text, -- what we now know, as it goes into client memory
  deployed_to uuid[] not null default '{}',
  deploy_baseline jsonb not null default '{}', -- per deployed client, to see the effect over time
  deployed_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lab_tests_status on public.lab_tests (status, created_at desc);

-- A test reaches each client as a suggested brief, so a person still checks it before anything is made
alter table public.creative_suggestions add column lab_test_id uuid references public.lab_tests (id) on delete set null;
drop index public.creative_suggestions_one_open;
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id) where status = 'open' and kind <> 'lab';

-- Learnings from the lab go into client memory
alter table public.client_memory drop constraint client_memory_source_check;
alter table public.client_memory add constraint client_memory_source_check check (source in ('team', 'client', 'review', 'copy', 'lab'));

alter table public.lab_sources enable row level security;
alter table public.lab_threads enable row level security;
alter table public.lab_messages enable row level security;
alter table public.lab_tests enable row level security;
create policy "leads use lab sources" on public.lab_sources for all to authenticated using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());
create policy "leads use lab threads" on public.lab_threads for all to authenticated using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());
create policy "leads read lab messages" on public.lab_messages for select to authenticated using (private.is_exec_or_lead());
create policy "leads write lab messages" on public.lab_messages for insert to authenticated with check (private.is_exec_or_lead() and role = 'user' and author_id = private.current_profile_id());
create policy "leads use lab tests" on public.lab_tests for all to authenticated using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('lab', 'Ads Lab table', 'The round table in the Ads Lab: a strategist, a copywriter, a creative director, a media buyer and an analyst think through ideas together with execs and leads, propose tests, spot tests already running, and read results.', 'opus', 'high', true, 12, 'spark', '{}')
on conflict (key) do nothing;
