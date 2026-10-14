-- Kaizen Ads — KPI dashboard
-- The buyer sets a target (from strategy or from the client) and a monthly budget per ad account.
-- Ad numbers are pulled per campaign per day; every sync recomputes each target's snapshot:
-- moving averages, deviation from target (14-day), month and quarter comparisons, and budget pacing.

create table public.kpi_targets (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  platform        text not null default 'meta' check (platform in ('meta', 'google')),
  ad_account_id   text,                    -- Meta account (no act_) or Google customer ID
  label           text,                    -- when a client has several targets, e.g. "Bridal Boudoir"
  conversion      text not null default 'purchases', -- see src/lib/kpi/conversions.ts
  custom_action   text,                    -- a specific Meta action type, e.g. offsite_conversion.custom.123
  campaign_match  text,                    -- only campaigns whose name contains this
  target          numeric(12, 2),          -- cost per result, or ROAS when conversion = 'roas'
  monthly_budget  numeric(12, 2),
  budget_note     text,
  source          text not null default 'strategy' check (source in ('strategy', 'client')),
  owner_id        uuid references public.profiles(id) on delete set null,
  owner_name      text,                    -- buyers who aren't in the app yet (Google team)
  active          boolean not null default true,
  updated_by      uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index on public.kpi_targets (client_id);
create index on public.kpi_targets (platform, ad_account_id);
alter table public.kpi_targets enable row level security;
create policy "staff read kpi targets" on public.kpi_targets for select to authenticated
  using (private.staff_can_see_client(client_id));
create policy "staff on the client set kpi targets" on public.kpi_targets for all to authenticated
  using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));

-- Per campaign per day. actions / action_values are {action_type: number} maps (small and fast to sum)
create table public.meta_campaign_daily (
  ad_account_id    text not null,
  campaign_id      text not null,
  date             date not null,
  campaign_name    text,
  spend            numeric(12, 2) not null default 0,
  impressions      bigint not null default 0,
  clicks           bigint not null default 0,
  link_clicks      bigint not null default 0,
  unique_link_clicks bigint not null default 0,
  actions          jsonb not null default '{}',
  action_values    jsonb not null default '{}',
  updated_at       timestamptz not null default now(),
  primary key (campaign_id, date)
);
create index on public.meta_campaign_daily (ad_account_id, date desc);
alter table public.meta_campaign_daily enable row level security;
-- Read through kpi_snapshots; raw rows are for the server

-- What the dashboard shows, recomputed on every sync
create table public.kpi_snapshots (
  target_id     uuid primary key references public.kpi_targets(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  computed_at   timestamptz not null default now(),
  data_through  date,
  windows       jsonb not null default '{}',  -- d3…d90: {spend, results, value}
  months        jsonb not null default '{}',  -- mtd, lastMonth, qtd, lastQuarter: {spend, results, value}
  deviation     numeric,                       -- 14-day vs target; positive = worse than target
  vs_month      numeric,                       -- month to date vs last month; positive = worse
  vs_quarter    numeric,
  status        text,                          -- excellent | good | close | off | idle | setup
  trend         text,                          -- improving | steady | slipping
  budget        jsonb not null default '{}',   -- spent, expected, projected, pace, status, dailyNeeded
  daily         jsonb not null default '[]',   -- last 30 days: [{d, spend, results}]
  error         text
);
create index on public.kpi_snapshots (client_id);
alter table public.kpi_snapshots enable row level security;
create policy "staff read kpi snapshots" on public.kpi_snapshots for select to authenticated
  using (private.staff_can_see_client(client_id));
