-- The Google Ads go-to-market strategy (the same shape and review as the Meta one), and each client's store and CRM
-- connections (Shopify, WooCommerce, GoHighLevel, HubSpot) with what they report: real customers, subscriptions and
-- lead outcomes, so audits, reports and the Bible judge by profit, not platform numbers.

create table if not exists public.client_google_gtm (
  client_id        uuid primary key references public.clients(id) on delete cascade,
  status           text not null default 'waiting' check (status in ('waiting', 'building', 'draft', 'reviewed', 'failed')),
  missing          text[] not null default '{}',
  version          text not null default 'v1.0',
  markdown         text not null default '',
  read_this_first  text not null default '',
  open_items       jsonb not null default '[]',
  quality          jsonb not null default '[]',
  research         text not null default '',
  error            text,
  started_at       timestamptz,
  generated_at     timestamptz,
  generated_by     uuid references public.profiles(id) on delete set null,
  reviewed_at      timestamptz,
  reviewed_by      uuid constraint client_google_gtm_reviewed_by_fkey references public.profiles(id) on delete set null
);
alter table public.client_google_gtm enable row level security;
create policy "staff read google gtm" on public.client_google_gtm for select to authenticated using (private.staff_can_see_client(client_id));
create policy "leads review google gtm" on public.client_google_gtm for update to authenticated
  using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());

-- A connection to a store or CRM. What it is and how it's doing; the key itself lives in client_integration_secrets.
create table if not exists public.client_integrations (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  kind           text not null check (kind in ('shopify', 'woocommerce', 'gohighlevel', 'hubspot', 'other')),
  account        text not null default '',          -- the store's myshopify domain, the site URL, the GHL location ID, the HubSpot portal
  label          text,
  status         text not null default 'connected' check (status in ('connected', 'error', 'disconnected', 'pending')),
  settings       jsonb not null default '{}',        -- e.g. the GHL pipeline stages read as booked / won / lost
  last_synced_at timestamptz,
  last_error     text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (client_id, kind, account)
);
alter table public.client_integrations enable row level security;
create policy "staff read integrations" on public.client_integrations for select to authenticated using (private.staff_can_see_client(client_id));

-- The keys, encrypted by the app (AES-256-GCM): never readable from the browser, never shown again once saved
create table if not exists public.client_integration_secrets (
  integration_id uuid primary key references public.client_integrations(id) on delete cascade,
  secret         text not null,
  updated_at     timestamptz not null default now()
);
alter table public.client_integration_secrets enable row level security;

-- One day of their business as their store or CRM saw it, per source
create table if not exists public.client_business_daily (
  client_id             uuid not null references public.clients(id) on delete cascade,
  date                  date not null,
  source                text not null,
  revenue               numeric not null default 0,
  orders                int not null default 0,
  new_customers         int not null default 0,
  returning_customers   int not null default 0,
  subscriptions_started int not null default 0,
  leads                 int not null default 0,
  booked                int not null default 0,
  won                   int not null default 0,
  lost                  int not null default 0,
  won_value             numeric not null default 0,
  from_meta             int not null default 0,      -- orders or leads whose UTMs / click IDs say Meta
  from_google           int not null default 0,
  updated_at            timestamptz not null default now(),
  primary key (client_id, date, source)
);
alter table public.client_business_daily enable row level security;
create policy "staff read business daily" on public.client_business_daily for select to authenticated using (private.staff_can_see_client(client_id));

-- The latest events (orders, subscriptions, leads moving stage), for notices and the agents
create table if not exists public.client_business_events (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  source       text not null,
  kind         text not null check (kind in ('order', 'subscription', 'lead', 'booked', 'won', 'lost')),
  external_id  text not null,
  occurred_at  timestamptz not null,
  value        numeric,
  first_order  boolean,
  attribution  text check (attribution in ('meta', 'google', 'other')),
  detail       jsonb not null default '{}',
  notified_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (client_id, source, kind, external_id)
);
create index if not exists client_business_events_recent on public.client_business_events (client_id, occurred_at desc);
alter table public.client_business_events enable row level security;
create policy "staff read business events" on public.client_business_events for select to authenticated using (private.staff_can_see_client(client_id));
