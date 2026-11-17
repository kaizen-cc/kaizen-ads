-- Email providers beyond Klaviyo: Brevo (Gold Rush Cabaret) and Customer.io (Fig). They are only more SOURCES feeding
-- the same email tables the board, the score, the reports, the audits and the chat already read (klaviyo_campaigns,
-- klaviyo_flows, klaviyo_audiences, klaviyo_audience_sizes, klaviyo_daily, klaviyo_flow_daily, klaviyo_previews): there is
-- no parallel feature set. A client has at most one email provider connected (the app refuses a second until the first is
-- removed). Each connection keeps the key sealed exactly like klaviyo_connections (AES-256-GCM, TOKEN_ENCRYPTION_KEY),
-- never readable from the browser (RLS on, no policies). Read only: nothing here sends or edits anything at the provider.
--
-- Additive and idempotent. Nothing is deleted. Nothing reads these tables before this is applied.

-- 1. Brevo: one account (organization) per client, one client per account
create table if not exists public.brevo_connections (
  client_id        uuid primary key references public.clients (id) on delete cascade,
  account_id       text not null,
  account_name     text,
  timezone         text,
  currency         text,
  key_iv           text,
  key_tag          text,
  key_ciphertext   text,
  key_last4        text,
  -- Whether the ecommerce attribution endpoints answered (null: not known yet). Without it revenue stays unmeasured.
  revenue_read     boolean,
  connected_by     uuid references public.profiles (id) on delete set null,
  connected_at     timestamptz not null default now(),
  status           text not null default 'active' check (status in ('active', 'invalid')),
  last_synced_at   timestamptz,
  backfilled_at    timestamptz,
  last_error       text,
  updated_at       timestamptz not null default now(),
  constraint brevo_connections_cipher check (key_iv is not null and key_tag is not null and key_ciphertext is not null)
);
create unique index if not exists brevo_connections_account on public.brevo_connections (account_id);
alter table public.brevo_connections enable row level security;
revoke all on public.brevo_connections from anon, authenticated;

-- 2. Customer.io: one workspace per client, a region (the App API lives at api.customer.io or api-eu.customer.io), and
--    an optional event name whose value counts as revenue (the App API reports no revenue of its own)
create table if not exists public.customerio_connections (
  client_id        uuid primary key references public.clients (id) on delete cascade,
  account_id       text not null,
  account_name     text,
  timezone         text,
  currency         text,
  region           text not null default 'us' check (region in ('us', 'eu')),
  revenue_event    text,
  revenue_read     boolean,
  key_iv           text,
  key_tag          text,
  key_ciphertext   text,
  key_last4        text,
  connected_by     uuid references public.profiles (id) on delete set null,
  connected_at     timestamptz not null default now(),
  status           text not null default 'active' check (status in ('active', 'invalid')),
  last_synced_at   timestamptz,
  backfilled_at    timestamptz,
  last_error       text,
  updated_at       timestamptz not null default now(),
  constraint customerio_connections_cipher check (key_iv is not null and key_tag is not null and key_ciphertext is not null)
);
create unique index if not exists customerio_connections_account on public.customerio_connections (account_id);
alter table public.customerio_connections enable row level security;
revoke all on public.customerio_connections from anon, authenticated;

-- 3. Where each shared row came from. Every existing row is Klaviyo's (the default), so nothing changes for them.
alter table public.klaviyo_campaigns add column if not exists source text not null default 'klaviyo';
alter table public.klaviyo_flows add column if not exists source text not null default 'klaviyo';
alter table public.klaviyo_audiences add column if not exists source text not null default 'klaviyo';
alter table public.klaviyo_daily add column if not exists source text not null default 'klaviyo';

comment on table public.brevo_connections is 'Each client''s Brevo account: read-only API key encrypted with TOKEN_ENCRYPTION_KEY; server only';
comment on table public.customerio_connections is 'Each client''s Customer.io workspace: App API key encrypted with TOKEN_ENCRYPTION_KEY; server only';
comment on column public.klaviyo_campaigns.source is 'Which email provider the row was read from: klaviyo, brevo or customerio';
