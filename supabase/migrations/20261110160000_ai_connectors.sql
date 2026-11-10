-- Connectors in Kaizen AI: the same remote MCP servers the team uses in Claude (Shopify, Google Drive, Asana, Canva,
-- ...), each person connecting their own account and switching them on per chat.
-- 1. ai_connectors: the catalog execs keep (name, icon, the server's URL, how it signs in, who it's offered to, a note).
-- 2. ai_connector_secrets: what the server needs and nobody reads: the exec's OAuth client secret, the client Kaizen Ads
--    registered with the server itself (dynamic client registration) and the server's OAuth endpoints. Service role only.
-- 3. ai_connections: a person's connection to a connector (status, when it expires, the tools it offers). Their own.
-- 4. ai_connection_tokens: that connection's tokens, encrypted (AES-256-GCM with TOKEN_ENCRYPTION_KEY). Service role only:
--    the server reads them for that person's own requests, never anyone else's.
-- 5. ai_thread_connectors: which connected services are switched on in a thread (no row: every connected one).
-- Safe to run twice.

create table if not exists public.ai_connectors (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_-]{1,39}$'),
  name text not null,
  icon_url text,
  url text not null,
  auth text not null default 'oauth' check (auth in ('oauth', 'oauth_client', 'token', 'none')),
  client_id text,
  scopes text,
  note text,
  -- the roles it's offered to (null or empty = everyone)
  roles text[],
  enabled boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_connector_secrets (
  connector_id uuid primary key references public.ai_connectors(id) on delete cascade,
  client_secret_iv text,
  client_secret_tag text,
  client_secret_ciphertext text,
  -- the OAuth client registered with the server for this redirect URI (dynamic client registration)
  reg_client_id text,
  reg_redirect_uri text,
  reg_secret_iv text,
  reg_secret_tag text,
  reg_secret_ciphertext text,
  -- { issuer, authorization_endpoint, token_endpoint, registration_endpoint, scopes, token_auth_methods }
  auth_meta jsonb,
  auth_meta_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_connections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  connector_id uuid not null references public.ai_connectors(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'needs_reconnect')),
  token_last4 text,
  expires_at timestamptz,
  scope text,
  -- [{ name, title, about, readOnly, destructive }] from the server's tools/list
  tools jsonb not null default '[]',
  tools_checked_at timestamptz,
  last_error text,
  last_used_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, connector_id)
);
create index if not exists ai_connections_profile_idx on public.ai_connections (profile_id);

create table if not exists public.ai_connection_tokens (
  connection_id uuid primary key references public.ai_connections(id) on delete cascade,
  access_iv text not null,
  access_tag text not null,
  access_ciphertext text not null,
  refresh_iv text,
  refresh_tag text,
  refresh_ciphertext text,
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_thread_connectors (
  thread_id uuid primary key references public.ai_threads(id) on delete cascade,
  keys text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.ai_connectors enable row level security;
alter table public.ai_connector_secrets enable row level security;
alter table public.ai_connections enable row level security;
alter table public.ai_connection_tokens enable row level security;
alter table public.ai_thread_connectors enable row level security;

-- The catalog: every staff member reads it (what's offered is decided on the server by role); execs change it
drop policy if exists "ai connectors read" on public.ai_connectors;
create policy "ai connectors read" on public.ai_connectors for select to authenticated using (private.is_staff());
drop policy if exists "ai connectors exec" on public.ai_connectors;
create policy "ai connectors exec" on public.ai_connectors for all to authenticated using (private.is_exec()) with check (private.is_exec());

-- Secrets and tokens: no policies, so only the service role (the server) reads or writes them
revoke all on public.ai_connector_secrets from anon, authenticated;
revoke all on public.ai_connection_tokens from anon, authenticated;

-- A person's own connections: they read and remove theirs; the server writes them
drop policy if exists "ai connections own read" on public.ai_connections;
create policy "ai connections own read" on public.ai_connections for select to authenticated
  using (private.is_staff() and profile_id = private.current_profile_id());
drop policy if exists "ai connections own delete" on public.ai_connections;
create policy "ai connections own delete" on public.ai_connections for delete to authenticated
  using (private.is_staff() and profile_id = private.current_profile_id());

-- A thread's switches: the thread's owner only
drop policy if exists "ai thread connectors own" on public.ai_thread_connectors;
create policy "ai thread connectors own" on public.ai_thread_connectors for all to authenticated
  using (exists (select 1 from public.ai_threads t where t.id = thread_id and t.profile_id = private.current_profile_id()))
  with check (exists (select 1 from public.ai_threads t where t.id = thread_id and t.profile_id = private.current_profile_id()));

-- ─── The live catalog (Anthropic's MCP subregistry, synced daily) ────────────
-- 6. ai_connector_registry: every remote MCP server the registry lists, keyed by its registry name. Never deleted: a
--    server that's no longer active (or no longer remote) is marked unavailable.
-- 7. ai_connector_registry_state: where the sync is (the cursor it carries on from, the last full pull, the weekly notice).
-- 8. ai_connector_registry_seen: when each exec last looked at the catalog ("New" and "Updated" badges).
-- ai_connectors gets the registry entry it was offered from, which keeps its URL and version current.

alter table public.ai_connectors add column if not exists registry_name text;
alter table public.ai_connectors add column if not exists registry_version text;
create unique index if not exists ai_connectors_registry_name_idx on public.ai_connectors (registry_name) where registry_name is not null;

create table if not exists public.ai_connector_registry (
  name text primary key,
  title text,
  description text,
  url text not null,
  transport text not null default 'streamable-http' check (transport in ('streamable-http', 'sse')),
  version text,
  icon_url text,
  website_url text,
  status text not null default 'active',
  available boolean not null default true,
  registry_updated_at timestamptz,
  published_at timestamptz,
  source text,
  first_seen_at timestamptz not null default now(),
  changed_at timestamptz,
  last_seen_at timestamptz not null default now()
);
create index if not exists ai_connector_registry_first_seen_idx on public.ai_connector_registry (first_seen_at desc);
create index if not exists ai_connector_registry_updated_idx on public.ai_connector_registry (registry_updated_at desc nulls last);

create table if not exists public.ai_connector_registry_state (
  id text primary key,
  source text,
  cursor text,
  cursor_since timestamptz,
  last_complete_at timestamptz,
  first_pull_done boolean not null default false,
  last_notice_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  last_count integer
);

create table if not exists public.ai_connector_registry_seen (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  seen_at timestamptz not null default now()
);

alter table public.ai_connector_registry enable row level security;
alter table public.ai_connector_registry_state enable row level security;
alter table public.ai_connector_registry_seen enable row level security;

drop policy if exists "ai connector registry exec read" on public.ai_connector_registry;
create policy "ai connector registry exec read" on public.ai_connector_registry for select to authenticated using (private.is_exec());
drop policy if exists "ai connector registry seen own" on public.ai_connector_registry_seen;
create policy "ai connector registry seen own" on public.ai_connector_registry_seen for all to authenticated
  using (profile_id = private.current_profile_id()) with check (profile_id = private.current_profile_id());
-- ai_connector_registry_state: no policies (the server only)
