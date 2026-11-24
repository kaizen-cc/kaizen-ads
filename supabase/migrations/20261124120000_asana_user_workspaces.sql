-- A person's own Asana (Nov 24 2026): only Kaizen's workspace counts by default; the other workspaces they belong to
-- are ignored unless they tick them on in Settings > Connections. A sign-in as an Asana account whose email isn't
-- theirs waits for them to confirm it before it's used. Last sync: when their tasks were last read with it.
alter table public.asana_user_tokens
  add column if not exists extra_workspaces text[] not null default '{}',
  add column if not exists confirmed boolean not null default true,
  add column if not exists last_synced_at timestamptz;
