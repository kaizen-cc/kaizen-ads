-- Klaviyo (email and SMS), read only, as context for each client's accounts. A lead or exec pastes the client's
-- read-only private API key in the client's Team & setup; the app checks it against Klaviyo's Accounts endpoint and
-- keeps it encrypted (AES-256-GCM, key in TOKEN_ENCRYPTION_KEY, the same helper as the Meta and TikTok tokens): iv,
-- auth tag and ciphertext, base64. The connection is never readable from the browser (RLS on, no policies); the synced
-- numbers are read by staff who can see the client. Nothing here sends, edits or schedules anything in Klaviyo.
--
-- Additive and idempotent: safe to run more than once. Nothing reads these tables before this is applied.

-- 1. One Klaviyo account per client, and one client per Klaviyo account
create table if not exists public.klaviyo_connections (
  client_id              uuid primary key references public.clients (id) on delete cascade,
  account_id             text not null,
  account_name           text,
  timezone               text,
  currency               text,
  key_iv                 text,
  key_tag                text,
  key_ciphertext         text,
  key_last4              text,
  -- The "Placed Order" metric every revenue number is read on (found on the first sync)
  conversion_metric_id   text,
  connected_by           uuid references public.profiles (id) on delete set null,
  connected_at           timestamptz not null default now(),
  -- active: in use · invalid: Klaviyo refused the key (a lead or exec replaces it)
  status                 text not null default 'active' check (status in ('active', 'invalid')),
  last_synced_at         timestamptz,
  -- The first 90-day pull is done
  backfilled_at          timestamptz,
  last_error             text,
  updated_at             timestamptz not null default now(),
  constraint klaviyo_connections_cipher check (key_iv is not null and key_tag is not null and key_ciphertext is not null)
);
create unique index if not exists klaviyo_connections_account on public.klaviyo_connections (account_id);
alter table public.klaviyo_connections enable row level security;
revoke all on public.klaviyo_connections from anon, authenticated;

-- 2. Campaigns (email and SMS), with their numbers on Placed Order
create table if not exists public.klaviyo_campaigns (
  client_id        uuid not null references public.clients (id) on delete cascade,
  campaign_id      text not null,
  name             text,
  channel          text,
  status           text,
  send_time        timestamptz,
  audiences        text[] not null default '{}',
  subject          text,
  preview_text     text,
  recipients       bigint not null default 0,
  delivered        bigint not null default 0,
  opens_unique     bigint not null default 0,
  open_rate        numeric,
  clicks_unique    bigint not null default 0,
  click_rate       numeric,
  unsubscribes     bigint not null default 0,
  bounced          bigint not null default 0,
  spam_complaints  bigint not null default 0,
  conversions      numeric not null default 0,
  revenue          numeric not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (client_id, campaign_id)
);
create index if not exists klaviyo_campaigns_sent on public.klaviyo_campaigns (client_id, send_time desc);
alter table public.klaviyo_campaigns enable row level security;
drop policy if exists "staff read klaviyo campaigns" on public.klaviyo_campaigns;
create policy "staff read klaviyo campaigns" on public.klaviyo_campaigns for select to authenticated using (private.staff_can_see_client(client_id));

-- 3. Flows, with 30 and 90 days of numbers
create table if not exists public.klaviyo_flows (
  client_id      uuid not null references public.clients (id) on delete cascade,
  flow_id        text not null,
  name           text,
  status         text,
  trigger_type   text,
  revenue_30     numeric not null default 0,
  recipients_30  bigint not null default 0,
  open_rate_30   numeric,
  click_rate_30  numeric,
  conversions_30 numeric not null default 0,
  revenue_90     numeric not null default 0,
  recipients_90  bigint not null default 0,
  open_rate_90   numeric,
  click_rate_90  numeric,
  conversions_90 numeric not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (client_id, flow_id)
);
alter table public.klaviyo_flows enable row level security;
drop policy if exists "staff read klaviyo flows" on public.klaviyo_flows;
create policy "staff read klaviyo flows" on public.klaviyo_flows for select to authenticated using (private.staff_can_see_client(client_id));

-- 4. Lists and segments (the main ones carry their profile count)
create table if not exists public.klaviyo_audiences (
  client_id      uuid not null references public.clients (id) on delete cascade,
  audience_id    text not null,
  kind           text not null check (kind in ('list', 'segment')),
  name           text,
  profile_count  bigint,
  updated_at     timestamptz not null default now(),
  primary key (client_id, audience_id)
);
alter table public.klaviyo_audiences enable row level security;
drop policy if exists "staff read klaviyo audiences" on public.klaviyo_audiences;
create policy "staff read klaviyo audiences" on public.klaviyo_audiences for select to authenticated using (private.staff_can_see_client(client_id));

-- 5. The account's totals per day: attributed revenue (campaigns on their send day, flows by day) and messages sent
create table if not exists public.klaviyo_daily (
  client_id            uuid not null references public.clients (id) on delete cascade,
  date                 date not null,
  campaign_revenue     numeric not null default 0,
  flow_revenue         numeric not null default 0,
  revenue              numeric not null default 0,
  campaign_recipients  bigint not null default 0,
  flow_recipients      bigint not null default 0,
  sends                bigint not null default 0,
  campaigns_sent       integer not null default 0,
  conversions          numeric not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (client_id, date)
);
alter table public.klaviyo_daily enable row level security;
drop policy if exists "staff read klaviyo days" on public.klaviyo_daily;
create policy "staff read klaviyo days" on public.klaviyo_daily for select to authenticated using (private.staff_can_see_client(client_id));

comment on table public.klaviyo_connections is 'Each client''s Klaviyo account: read-only private API key encrypted with TOKEN_ENCRYPTION_KEY; server only';
comment on table public.klaviyo_daily is 'Klaviyo email and SMS totals per client per day (read only, synced daily)';
