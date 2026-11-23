-- Each person's own Asana (owner, Nov 23 2026): "Next for me in Asana" mirrors exactly what they see in Asana > My
-- tasks, private tasks included, so each person connects their own Asana (OAuth). Reads and writes go through their
-- token (attributed to them); the shared token is only the fallback while they haven't connected. Like
-- slack_user_tokens: the server reads it, nobody else.

create table if not exists public.asana_user_tokens (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  asana_user_gid text not null,
  email text,
  name text,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  workspaces jsonb not null default '[]'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.asana_user_tokens enable row level security;
-- No policies: only the server (service key) reads or writes tokens
