-- Briefs the AI strategist suggests to execs and leads, from what the data says (fatigue, KPIs off, behind on
-- creative, a new offer with no request, a client who isn't happy). A person approves (tickets are made), edits,
-- declines with a reason (the strategist reads every reason next time), or talks it through with the AI.

create table public.creative_suggestions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  kind text not null check (kind in ('fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab')),
  signal text not null, -- one line: what the data showed
  evidence jsonb not null default '[]', -- the facts behind it, as short lines
  why text not null, -- the strategist's case for it
  draft jsonb not null, -- { title, angle, audience, brief, hooks[], concepts[], formats[], sizes[], landing }
  original jsonb not null, -- the AI's first draft, to learn from what people changed
  status text not null default 'open' check (status in ('open', 'approved', 'declined', 'expired')),
  version int not null default 1,
  edited boolean not null default false,
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decline_reason text,
  request_numbers int[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One open suggestion per client at a time
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id) where status = 'open';
create index creative_suggestions_recent on public.creative_suggestions (status, created_at desc);

create table public.suggestion_messages (
  id uuid primary key default gen_random_uuid(),
  suggestion_id uuid not null references public.creative_suggestions (id) on delete cascade,
  role text not null check (role in ('user', 'ai')),
  author_id uuid references public.profiles (id),
  body text not null,
  created_at timestamptz not null default now()
);
create index suggestion_messages_by on public.suggestion_messages (suggestion_id, created_at);

-- Each run of the strategist (the Home page shows one in progress)
create table public.suggestion_runs (
  id uuid primary key default gen_random_uuid(),
  started_by uuid references public.profiles (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  looked_at int not null default 0,
  made int not null default 0,
  error text
);

alter table public.creative_suggestions enable row level security;
alter table public.suggestion_messages enable row level security;
alter table public.suggestion_runs enable row level security;

create policy "leads read suggestions" on public.creative_suggestions for select to authenticated using (private.is_exec_or_lead());
create policy "leads update suggestions" on public.creative_suggestions for update to authenticated using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());
create policy "leads read suggestion chat" on public.suggestion_messages for select to authenticated using (private.is_exec_or_lead());
create policy "leads write suggestion chat" on public.suggestion_messages for insert to authenticated with check (private.is_exec_or_lead() and role = 'user' and author_id = private.current_profile_id());
create policy "leads read suggestion runs" on public.suggestion_runs for select to authenticated using (private.is_exec_or_lead());

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('strategist', 'Strategist', 'Watches every account for what needs new creative (ads tiring, KPIs off, behind on the month''s creative, a new offer in Slack with no request, a client who isn''t happy) and suggests a full brief with concepts to execs and leads on Home. Reads every reason a suggestion was declined.', 'opus', 'medium', true, 11, 'target', '{}')
on conflict (key) do nothing;
