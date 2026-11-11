-- The ticket rebuilt stage by stage (Board). Idempotent; the app works before this is applied (it reads launched
-- tickets as completed, keeps the brief chat in the browser and writes a video's script to request_scripts only).

-- 1. Completing a ticket: when and who (the system when Meta shows the ad live, or the buyer with "Complete task")
alter table public.requests add column if not exists completed_at timestamptz;
alter table public.requests add column if not exists completed_by uuid references public.profiles (id) on delete set null;
create index if not exists requests_completed_at_idx on public.requests (completed_at desc) where completed_at is not null;

-- 2. The creative's own copy, written the moment production starts: a video's script, an image's headline and
--    subheadline per version, a carousel's headline and subline per slide per version. Chat edits keep the earlier
--    content in history (newest last), so the maker can undo.
create table if not exists public.ticket_copy_drafts (
  request_id  uuid primary key references public.requests (id) on delete cascade,
  client_id   uuid not null references public.clients (id) on delete cascade,
  status      text not null default 'writing' check (status in ('writing', 'ready', 'failed')),
  progress    text,
  content     jsonb,
  history     jsonb not null default '[]',
  changes     jsonb not null default '[]',
  messages    jsonb not null default '[]',
  error       text,
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists ticket_copy_drafts_client_idx on public.ticket_copy_drafts (client_id);
alter table public.ticket_copy_drafts enable row level security;
drop policy if exists "staff read ticket copy drafts" on public.ticket_copy_drafts;
create policy "staff read ticket copy drafts" on public.ticket_copy_drafts for select to authenticated using (private.staff_can_see_client(client_id));
-- Written by the server after the AI call

-- 3. Questions about the brief, asked on the ticket and answered by the AI with the brief, the client's context and
--    the Brand Bible
create table if not exists public.ticket_brief_chat (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests (id) on delete cascade,
  client_id   uuid not null references public.clients (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  body        text not null,
  author_id   uuid references public.profiles (id) on delete set null,
  author_name text,
  created_at  timestamptz not null default now()
);
create index if not exists ticket_brief_chat_request_idx on public.ticket_brief_chat (request_id, created_at);
alter table public.ticket_brief_chat enable row level security;
drop policy if exists "staff read ticket brief chat" on public.ticket_brief_chat;
create policy "staff read ticket brief chat" on public.ticket_brief_chat for select to authenticated using (private.staff_can_see_client(client_id));

comment on column public.requests.completed_at is 'When the ticket was completed: Meta showed its ad live, or the buyer pressed Complete task';
comment on table public.ticket_copy_drafts is 'The creative''s own copy on a ticket (script, headlines per version, slide lines), written at Start production; server only writes';
comment on table public.ticket_brief_chat is 'Questions about a ticket''s brief and the AI''s answers; server only writes';
