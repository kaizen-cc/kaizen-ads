-- Kaizen Ads — every Meta metric, per ad per day, for the KPI dashboard and the AI. Ranges and campaign/ad set
-- roll-ups are summed from here. Reach (unique people) can't be summed, so it's stored per window separately.
create table public.meta_ad_daily (
  client_id     uuid not null references public.clients(id) on delete cascade,
  ad_account_id text not null,
  date          date not null,
  ad_id         text not null,
  ad_name       text,
  adset_id      text,
  adset_name    text,
  campaign_id   text,
  campaign_name text,
  metrics       jsonb not null,   -- Meta's row as returned: spend, impressions, reach, clicks, actions, action_values, video, rankings…
  updated_at    timestamptz not null default now(),
  primary key (ad_id, date)
);
create index on public.meta_ad_daily (client_id, date desc);
create index on public.meta_ad_daily (campaign_id, date);
alter table public.meta_ad_daily enable row level security;
create policy "staff read meta daily" on public.meta_ad_daily for select to authenticated using (private.staff_can_see_client(client_id));

-- Unique people over a window (last 7 / 30 days), for the account and each campaign
create table public.meta_reach (
  client_id     uuid not null references public.clients(id) on delete cascade,
  ad_account_id text not null,
  level         text not null check (level in ('account', 'campaign')),
  object_id     text not null,
  object_name   text,
  window_days   int not null,
  date_start    date not null,
  date_stop     date not null,
  reach         bigint,
  frequency     numeric,
  impressions   bigint,
  updated_at    timestamptz not null default now(),
  primary key (object_id, window_days)
);
create index on public.meta_reach (client_id);
alter table public.meta_reach enable row level security;
create policy "staff read meta reach" on public.meta_reach for select to authenticated using (private.staff_can_see_client(client_id));
