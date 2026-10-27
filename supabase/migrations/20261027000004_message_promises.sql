-- Things the team said they'd do in Slack or email: a yes to a request, in whatever words ("love it, let's run with
-- that", "I'll get this to design", a thumbs-up on a clear ask). Watched until something shows it moving (a ticket, an
-- Asana task, the thread itself); past its due date with nothing, the person who said it hears, then their lead and
-- the execs. Every message the AI looked at is kept (not_promise) so it's read once.
create table if not exists public.message_promises (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'gmail')),
  message_key text not null, -- the message (or reaction) where it was said
  owner_id uuid references public.profiles(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  channel_id text,
  channel_name text,
  thread_ts text,
  message_ts text,
  mailbox text,
  gmail_thread_id text,
  asked_by text,
  asked_team boolean not null default false,
  ask text, -- what was asked, in a line
  what text, -- what we said we'd do, in a line
  kind text check (kind in ('creative', 'copy', 'offer', 'launch', 'change', 'task')),
  said text, -- the words (or the reaction) it was said in
  said_at timestamptz not null,
  due_at timestamptz,
  url text,
  channel_url text,
  status text not null default 'open' check (status in ('not_promise', 'open', 'overdue', 'escalated', 'in_motion', 'done', 'dismissed')),
  evidence text, -- what showed it moving
  request_numbers int[] not null default '{}',
  asana_gids text[] not null default '{}',
  checked_at timestamptz,
  notified_at timestamptz,
  escalated_at timestamptz,
  closed_at timestamptz,
  dismissed_by uuid references public.profiles(id) on delete set null,
  dismiss_reason text,
  created_at timestamptz not null default now(),
  unique (source, message_key)
);
create index if not exists message_promises_open on public.message_promises (status, due_at) where status in ('open', 'overdue', 'escalated');
create index if not exists message_promises_owner on public.message_promises (owner_id, status);

alter table public.message_promises enable row level security;
create policy "people read their own message promises, leads and execs all" on public.message_promises for select to authenticated
  using (owner_id = private.current_profile_id() or private.is_exec_or_lead());
