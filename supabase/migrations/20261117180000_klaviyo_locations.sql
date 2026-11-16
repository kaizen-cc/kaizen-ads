-- Multi-location email reporting (Crust Pizza Co., Angry Chickz, Atomic Wings, E11EVEN Miami...): each conversion
-- metric's attributed orders split by the restaurant they came from, per campaign or automated email message. The
-- email report's last section and the Email board's account sheet read it.
--
-- A lead or an exec turns it on for a client (the sync suggests it when a metric's events carry more than one location)
-- and picks, per conversion metric, the event property holding the location: Toast and a custom POS name it
-- differently. The Klaviyo sync fills klaviyo_location_daily once a day for flagged clients only.
--
-- Additive and idempotent: safe to run more than once, nothing dropped or deleted. The app works before it's applied
-- (no location section, no setting).

alter table public.klaviyo_connections add column if not exists multi_location boolean not null default false;
alter table public.klaviyo_connections add column if not exists location_props jsonb not null default '{}'::jsonb;
comment on column public.klaviyo_connections.multi_location is 'Break the email reports and the board down by location (a lead or an exec turns it on)';
comment on column public.klaviyo_connections.location_props is 'Per conversion metric, the event property holding the location: {metricId: propertyName}';

-- One metric's attributed conversions at a location on a day, for one message (a campaign message or a flow message)
create table if not exists public.klaviyo_location_daily (
  client_id    uuid not null references public.clients (id) on delete cascade,
  metric_id    text not null,
  date         date not null,
  location     text not null,
  message_id   text not null,
  campaign_id  text,
  flow_id      text,
  conversions  numeric not null default 0,
  revenue      numeric not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (client_id, metric_id, date, location, message_id)
);
create index if not exists klaviyo_location_daily_by_date on public.klaviyo_location_daily (client_id, date);
create index if not exists klaviyo_location_daily_by_campaign on public.klaviyo_location_daily (client_id, campaign_id) where campaign_id is not null;

-- Read only, like the other klaviyo_* tables: staff who can see the client read it, nothing in the browser writes it
alter table public.klaviyo_location_daily enable row level security;
drop policy if exists "staff read klaviyo location days" on public.klaviyo_location_daily;
create policy "staff read klaviyo location days" on public.klaviyo_location_daily for select to authenticated using (private.staff_can_see_client(client_id));

comment on table public.klaviyo_location_daily is 'Klaviyo attributed conversions and revenue per client, conversion metric, day, location and message (read only, synced daily for multi-location clients)';
