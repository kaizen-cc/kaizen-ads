-- The client's Slack channel inside their portal: a copy of the channel's messages (read from Slack, and pushed by
-- Slack's events when they're switched on), what each contact has read, and how far back history has been loaded.
-- Read and written by the server only (admin client) after its own checks: no policies, so nothing is readable
-- from the browser.

create table if not exists public.portal_chat_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  channel text not null,
  ts text not null,
  thread_ts text,
  -- Slack user who wrote it (null for the app's own posts)
  user_id text,
  author_name text,
  author_avatar text,
  -- Someone on the Kaizen team (a full workspace member), as opposed to the client's side of a shared channel
  from_team boolean not null default false,
  -- Written by a client contact in the portal (posted by the app under their name)
  from_portal boolean not null default false,
  contact_id uuid references public.contacts(id) on delete set null,
  text text not null default '',
  files jsonb not null default '[]'::jsonb,
  reply_count int not null default 0,
  latest_reply text,
  edited boolean not null default false,
  deleted boolean not null default false,
  sent_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (channel, ts)
);
create index if not exists portal_chat_messages_client_ts on public.portal_chat_messages (client_id, sent_at desc);
create index if not exists portal_chat_messages_thread on public.portal_chat_messages (channel, thread_ts);
alter table public.portal_chat_messages enable row level security;

create table if not exists public.portal_chat_state (
  client_id uuid primary key references public.clients(id) on delete cascade,
  channel text not null,
  synced_at timestamptz,
  -- Oldest message loaded so far, and whether Slack has older ones
  oldest_ts text,
  has_more boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.portal_chat_state enable row level security;

-- Unread: the last message each reader (a contact, or a team member viewing the portal) has seen
create table if not exists public.portal_chat_reads (
  client_id uuid not null references public.clients(id) on delete cascade,
  reader_id uuid not null,
  last_read_ts text not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, reader_id)
);
alter table public.portal_chat_reads enable row level security;

-- An email digest of unread team messages: built, off until client outreach is launched
insert into public.app_settings (key, value)
values ('portal_chat_digest', '{"on": false}'::jsonb)
on conflict (key) do nothing;
