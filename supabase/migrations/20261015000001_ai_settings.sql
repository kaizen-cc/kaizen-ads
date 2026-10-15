-- Kaizen Ads — AI agent settings
-- Each AI function is an "agent" execs can tune without a deploy: which model and effort it runs on, extra
-- instructions, knowledge and skills it always reads, and which client data it sees. Every call is logged.

create table public.ai_agents (
  key          text primary key,                 -- suggest | review | briefing | copy
  label        text not null,
  description  text not null default '',
  model        text not null check (model in ('opus', 'sonnet', 'haiku')),
  effort       text not null check (effort in ('low', 'medium', 'high')),
  instructions text not null default '',
  sources      jsonb not null default '{}',      -- which client data goes in: {meta: true, briefing: true, …}
  live         boolean not null default true,    -- false = not wired into the app yet
  sort_order   int not null default 0,
  updated_by   uuid references public.profiles(id) on delete set null,
  updated_at   timestamptz not null default now()
);

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources) values
  ('suggest', 'Brief strategist', 'Suggests the angle, audience, hook, copy direction and format mix while someone fills in a creative request.', 'sonnet', 'low', true, 1,
    '{"meta": true, "briefing": true, "recent_messages": true, "memory": true, "angles": true, "recent_requests": true, "allotment": true}'),
  ('review', 'Request reviewer', 'Checks a finished request before it goes to the creative team: allotment, client memory, contradictions, Meta policy.', 'opus', 'medium', true, 2,
    '{"meta": true, "briefing": true, "recent_messages": true, "memory": true, "angles": true, "recent_requests": true, "allotment": true}'),
  ('briefing', 'Client briefer', 'Reads new Slack, email, Drive and Meta data twice a day and writes each client''s briefing.', 'haiku', 'low', true, 3,
    '{"meta": true, "briefing": true, "recent_messages": true, "memory": true, "angles": true, "recent_requests": true, "allotment": true}'),
  ('copy', 'Copywriter', 'Writes primary text, headlines and on-image copy for approved briefs. Not wired in yet: set it up here first.', 'sonnet', 'medium', false, 4,
    '{"meta": true, "briefing": true, "recent_messages": false, "memory": true, "angles": true, "recent_requests": true, "allotment": false}');

-- Knowledge (reference material), skills (how to do something) and examples (what good looks like).
-- agent_key null = every agent reads it.
create table public.ai_knowledge (
  id          uuid primary key default gen_random_uuid(),
  agent_key   text references public.ai_agents(key) on delete cascade,
  kind        text not null default 'knowledge' check (kind in ('knowledge', 'skill', 'example')),
  title       text not null,
  body        text not null,
  file_name   text,
  active      boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on public.ai_knowledge (agent_key) where active;

create table public.ai_runs (
  id            bigint generated always as identity primary key,
  agent_key     text,
  label         text,
  model         text,
  effort        text,
  ms            int,
  input_tokens  int,
  output_tokens int,
  ok            boolean not null default true,
  error         text,
  created_at    timestamptz not null default now()
);
create index on public.ai_runs (created_at desc);
create index on public.ai_runs (agent_key, created_at desc);

alter table public.ai_agents enable row level security;
alter table public.ai_knowledge enable row level security;
alter table public.ai_runs enable row level security;
create policy "staff read agents" on public.ai_agents for select to authenticated using (private.is_staff());
create policy "execs edit agents" on public.ai_agents for update to authenticated using (private.is_exec()) with check (private.is_exec());
create policy "staff read knowledge" on public.ai_knowledge for select to authenticated using (private.is_staff());
create policy "execs manage knowledge" on public.ai_knowledge for all to authenticated using (private.is_exec()) with check (private.is_exec());
create policy "execs read runs" on public.ai_runs for select to authenticated using (private.is_exec());
-- Runs are written by the server

-- The raw-metrics inspector reads campaign days; execs only
create policy "execs read campaign days" on public.meta_campaign_daily for select to authenticated using (private.is_exec());
