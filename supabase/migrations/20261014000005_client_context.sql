-- Kaizen Ads — client context from Slack, Gmail and Drive
-- A scheduled job (12pm and 6pm ET) pulls only what's new since its last run into context_items,
-- then refreshes each client's briefing: a short digest plus ready-made request suggestions.
-- The request form reads the briefing, so suggestions show instantly instead of waiting on the AI.

alter table public.clients
  add column internal_slack_channel_id text,   -- Kaizen-only channel about the client
  add column drive_folder_id text;             -- the client's folder in the shared Clients drive
comment on column public.clients.slack_channel_id is 'Channel shared with the client (external)';

create type public.context_source as enum ('slack_internal', 'slack_external', 'gmail', 'drive');

-- Raw items, one row per message, email or file. Bodies are trimmed; links go back to the source.
create table public.context_items (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  source      public.context_source not null,
  external_id text not null,              -- Slack ts, Gmail message id, Drive file id
  thread_id   text,
  occurred_at timestamptz not null,
  author      text,
  title       text,                       -- email subject or file name
  body        text,
  url         text,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  unique (source, external_id)
);
create index on public.context_items (client_id, occurred_at desc);
alter table public.context_items enable row level security;
create policy "staff read client context" on public.context_items for select to authenticated
  using (private.staff_can_see_client(client_id));

-- Where each source left off, so every run only reads what's new
create table public.sync_state (
  source      text primary key,           -- e.g. slack, gmail:jorgi@…, drive
  cursor_at   timestamptz,
  last_run_at timestamptz,
  last_result jsonb not null default '{}'
);
alter table public.sync_state enable row level security;
create policy "execs read sync state" on public.sync_state for select to authenticated using (private.is_exec());

-- What the AI knows about each client, refreshed by the scheduled job
create table public.client_briefings (
  client_id        uuid primary key references public.clients(id) on delete cascade,
  digest           jsonb not null default '{}',   -- summary, direction, asks, avoid, works, new assets
  suggestions      jsonb,                         -- ready-made request suggestions
  sources          jsonb not null default '{}',   -- counts read for the last refresh
  updated_through  timestamptz,                   -- newest item folded into the digest
  generated_at     timestamptz not null default now()
);
alter table public.client_briefings enable row level security;
create policy "staff read briefings" on public.client_briefings for select to authenticated
  using (private.staff_can_see_client(client_id));
