-- Each flow's conversions and revenue per day for EVERY ranked conversion metric (klaviyo_flow_daily holds the primary
-- only). A client with two order systems (Crust: Toast and its POS's API) gets each flow's revenue on both, added up in
-- the email report so the flow table matches the flows total and the headline. Written by the Klaviyo sync from the
-- daily flow series it already reads per metric. Read only, like the other klaviyo_* tables.
--
-- Additive and idempotent. The app works before it's applied (flows then read the primary only, as before).

create table if not exists public.klaviyo_flow_metric_daily (
  client_id    uuid not null references public.clients (id) on delete cascade,
  flow_id      text not null,
  metric_id    text not null,
  date         date not null,
  conversions  numeric not null default 0,
  revenue      numeric not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (client_id, metric_id, flow_id, date)
);
create index if not exists klaviyo_flow_metric_daily_by_date on public.klaviyo_flow_metric_daily (client_id, date);
alter table public.klaviyo_flow_metric_daily enable row level security;
drop policy if exists "staff read klaviyo flow metric days" on public.klaviyo_flow_metric_daily;
-- Client access checked once per query, not per row
create policy "staff read klaviyo flow metric days" on public.klaviyo_flow_metric_daily for select to authenticated
  using ((select private.is_staff()) and ((select private.staff_sees_all()) or client_id = any ((select private.staff_client_ids())::uuid[])));

comment on table public.klaviyo_flow_metric_daily is 'Klaviyo flow conversions and revenue per client, conversion metric, flow and day (read only, synced); the email report adds the counted order systems up per flow';
