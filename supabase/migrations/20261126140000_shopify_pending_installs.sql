-- A store that installed the Kaizen OS app from Shopify's side (the App Store listing, a reviewer, a merchant's own
-- click) before the team linked it to a client: its token waits here, encrypted, until it's matched (automatically by
-- the store address we found on the client's site, or by the team on the client page). Server only: no policies.
create table if not exists public.shopify_pending_installs (
  shop text primary key,
  name text,
  secret text not null,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.shopify_pending_installs enable row level security;
