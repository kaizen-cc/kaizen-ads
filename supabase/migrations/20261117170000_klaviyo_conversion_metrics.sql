-- Several Klaviyo metrics counting as the sale, ranked (a restaurant's Toast online orders first, its reservations
-- second...). The connection keeps the ordered list; conversion_metric_id / conversion_metric_name stay the primary, so
-- everything that reads them (klaviyo_daily, klaviyo_campaigns, klaviyo_flows, klaviyo_flow_daily: all the primary's
-- numbers) keeps working unchanged. Each picked metric's own numbers (the primary's too) go in three per-metric tables,
-- written by the Klaviyo sync; the score's money checks blend them by rank and the KPI board shows them side by side.
--
-- Additive and idempotent: safe to run more than once, nothing dropped or deleted. The app works before it's applied
-- (one metric, as before).

alter table public.klaviyo_connections add column if not exists conversion_metrics jsonb not null default '[]'::jsonb;
comment on column public.klaviyo_connections.conversion_metrics is 'The metrics that count as the sale, ranked: [{id, name, integration}], primary first (also in conversion_metric_id), four at most';

-- A metric picked by hand before this list existed becomes the list's primary
update public.klaviyo_connections
set conversion_metrics = jsonb_build_array(jsonb_build_object('id', conversion_metric_id, 'name', coalesce(conversion_metric_name, 'Conversion'), 'integration', null))
where conversion_metric_manual and conversion_metric_id is not null and conversion_metrics = '[]'::jsonb;

-- Each picked metric's attributed numbers per day (campaigns on their send day, flows from the daily series) and the
-- store's own total for that metric (Klaviyo's metric aggregate)
create table if not exists public.klaviyo_metric_daily (
  client_id         uuid not null references public.clients (id) on delete cascade,
  metric_id         text not null,
  date              date not null,
  campaign_revenue  numeric not null default 0,
  flow_revenue      numeric not null default 0,
  revenue           numeric not null default 0,
  conversions       numeric not null default 0,
  store_revenue     numeric,
  store_orders      numeric,
  updated_at        timestamptz not null default now(),
  primary key (client_id, metric_id, date)
);
create index if not exists klaviyo_metric_daily_by_date on public.klaviyo_metric_daily (client_id, date);

-- Each campaign's conversions and revenue per picked metric
create table if not exists public.klaviyo_campaign_metrics (
  client_id    uuid not null references public.clients (id) on delete cascade,
  campaign_id  text not null,
  metric_id    text not null,
  conversions  numeric not null default 0,
  revenue      numeric not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (client_id, campaign_id, metric_id)
);

-- Each flow's last 30 and 90 days per picked metric (the recent read refreshes the 30, the full read both)
create table if not exists public.klaviyo_flow_metrics (
  client_id       uuid not null references public.clients (id) on delete cascade,
  flow_id         text not null,
  metric_id       text not null,
  conversions_30  numeric not null default 0,
  revenue_30      numeric not null default 0,
  conversions_90  numeric not null default 0,
  revenue_90      numeric not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (client_id, flow_id, metric_id)
);

-- Read only, like the other klaviyo_* tables: staff who can see the client read them, nothing in the browser writes them
alter table public.klaviyo_metric_daily enable row level security;
alter table public.klaviyo_campaign_metrics enable row level security;
alter table public.klaviyo_flow_metrics enable row level security;
drop policy if exists "staff read klaviyo metric days" on public.klaviyo_metric_daily;
create policy "staff read klaviyo metric days" on public.klaviyo_metric_daily for select to authenticated using (private.staff_can_see_client(client_id));
drop policy if exists "staff read klaviyo campaign metrics" on public.klaviyo_campaign_metrics;
create policy "staff read klaviyo campaign metrics" on public.klaviyo_campaign_metrics for select to authenticated using (private.staff_can_see_client(client_id));
drop policy if exists "staff read klaviyo flow metrics" on public.klaviyo_flow_metrics;
create policy "staff read klaviyo flow metrics" on public.klaviyo_flow_metrics for select to authenticated using (private.staff_can_see_client(client_id));

comment on table public.klaviyo_metric_daily is 'Klaviyo attributed revenue per client, conversion metric and day, with the store total for that metric (read only, synced)';
comment on table public.klaviyo_campaign_metrics is 'Klaviyo campaign conversions and revenue per conversion metric (read only, synced)';
comment on table public.klaviyo_flow_metrics is 'Klaviyo flow 30 and 90 day conversions and revenue per conversion metric (read only, synced)';
