-- Klaviyo flows per day, so an email report reads each flow for its own week or month (Klaviyo's flow report only
-- gives the last 30 and 90 days). Written by the Klaviyo sync from the daily flow series it already reads: the full read
-- keeps 90 days, the recent read the last 30. Read only, like the other klaviyo_* tables: staff who can see the client
-- read it, nothing in the browser writes it.
--
-- Additive and idempotent: safe to run more than once. The app works before it's applied (reports fall back to the
-- flows' 30-day numbers).

create table if not exists public.klaviyo_flow_daily (
  client_id      uuid not null references public.clients (id) on delete cascade,
  flow_id        text not null,
  date           date not null,
  recipients     bigint not null default 0,
  delivered      bigint not null default 0,
  opens_unique   bigint not null default 0,
  clicks_unique  bigint not null default 0,
  -- Placed orders (the account's conversion metric) attributed to the flow that day
  conversions    numeric not null default 0,
  revenue        numeric not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (client_id, flow_id, date)
);
create index if not exists klaviyo_flow_daily_by_date on public.klaviyo_flow_daily (client_id, date);
alter table public.klaviyo_flow_daily enable row level security;
drop policy if exists "staff read klaviyo flow days" on public.klaviyo_flow_daily;
create policy "staff read klaviyo flow days" on public.klaviyo_flow_daily for select to authenticated using (private.staff_can_see_client(client_id));

comment on table public.klaviyo_flow_daily is 'Klaviyo flow numbers per client, flow and day (read only, from the daily flow series); the email reports read flows for their own dates';
