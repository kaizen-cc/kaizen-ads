-- Messages someone on the team was tagged in or sent (Slack, email) and hasn't answered. Watched from when it's
-- asked; a first notice to the person once it has waited too long, then their lead and the execs if it still
-- isn't answered after they've seen it (with a second notice to the person). One row per message per person.
create table if not exists public.owed_replies (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('slack', 'gmail')),
  message_key text not null, -- Slack "channel:ts", Gmail "mailbox:message id"
  target_id uuid not null references public.profiles(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  channel_id text,
  channel_name text,
  thread_ts text,
  message_ts text,
  mailbox text,
  gmail_thread_id text,
  from_name text,
  from_team boolean not null default false, -- a teammate asked (vs a client or someone outside)
  mentioned boolean not null default false, -- the person was tagged by name
  asked_at timestamptz not null,
  subject text,
  body text,
  gist text, -- what they're waiting on, in a line (the AI's read)
  url text, -- the message itself
  channel_url text, -- the channel (Slack)
  status text not null default 'watching' check (status in ('watching', 'nudged', 'escalated', 'answered', 'dismissed', 'not_needed')),
  checked_at timestamptz,
  nudged_at timestamptz,
  escalated_at timestamptz,
  answered_at timestamptz,
  dismissed_at timestamptz,
  dismissed_by uuid references public.profiles(id) on delete set null,
  dismiss_reason text,
  created_at timestamptz not null default now(),
  unique (source, message_key, target_id)
);
create index if not exists owed_replies_open on public.owed_replies (status, asked_at) where status in ('watching', 'nudged', 'escalated');
create index if not exists owed_replies_target on public.owed_replies (target_id, status);

alter table public.owed_replies enable row level security;
create policy "people read their own owed replies, leads and execs all" on public.owed_replies for select to authenticated
  using (target_id = private.current_profile_id() or private.is_exec_or_lead());

-- Who someone is in Slack, so a tag (<@U…>) finds them
alter table public.profiles add column if not exists slack_user_id text;
