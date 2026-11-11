-- The connector Directory (Settings, Connections, Team connectors, Add connector): the catalog keeps whether a server is
-- a well-known vendor's own (Featured, sorted first, with a verified tick) and which vendor. The sync fills both; rows
-- saved before this keep false and null until the next pull rewrites them. The sync's per-registry state now lives in
-- two rows of ai_connector_registry_state ("main" for Anthropic's registry, "official" for the official MCP registry),
-- which needs no change. Safe to run twice.

alter table public.ai_connector_registry add column if not exists featured boolean not null default false;
alter table public.ai_connector_registry add column if not exists vendor text;

-- The Directory's order: featured first, then the newest
create index if not exists ai_connector_registry_directory_idx on public.ai_connector_registry (available, featured desc, first_seen_at desc);
-- Which registry a row came from (the sync asks whether Anthropic's has brought anything)
create index if not exists ai_connector_registry_source_idx on public.ai_connector_registry (source);

-- Rows saved before these columns existed get them on a full pull: the next sync (daily, or Refresh now) reads the
-- whole registry again instead of only what changed. Nothing counts as new (first_pull_done stays), so no notice.
update public.ai_connector_registry_state set cursor = null, cursor_since = null, last_complete_at = null
  where id in ('main', 'official') and not exists (select 1 from public.ai_connector_registry where featured);
