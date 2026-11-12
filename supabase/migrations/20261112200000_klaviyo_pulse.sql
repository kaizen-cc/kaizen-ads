-- Klaviyo pulse (the client page's Email tab), read only. Adds to the Klaviyo tables:
--   1. klaviyo_daily: the store's own revenue and orders per day as Klaviyo sees them (the Placed Order metric), so
--      email's share of revenue works without a separate store connection; SMS revenue; list joins and leaves.
--   2. klaviyo_campaigns.message_id: the campaign's first message, for its preview.
--   3. klaviyo_previews: each campaign's email HTML (made safe on the way in) or SMS text, cached so a hover doesn't
--      call Klaviyo twice.
--   4. klaviyo_audience_sizes: a list or segment's size per day it was read, for growth over time.
--
-- Additive and idempotent: safe to run more than once. The app works before it's applied (it leaves these out).

-- 1. The store's revenue, SMS and list movement per day
alter table public.klaviyo_daily add column if not exists store_revenue numeric;
alter table public.klaviyo_daily add column if not exists store_orders numeric;
alter table public.klaviyo_daily add column if not exists sms_revenue numeric not null default 0;
alter table public.klaviyo_daily add column if not exists subscribed integer;
alter table public.klaviyo_daily add column if not exists unsubscribed integer;

-- 2. The message a campaign's preview is read from
alter table public.klaviyo_campaigns add column if not exists message_id text;

-- 3. Previews, cached
create table if not exists public.klaviyo_previews (
  client_id    uuid not null references public.clients (id) on delete cascade,
  campaign_id  text not null,
  message_id   text,
  channel      text,
  subject      text,
  preview_text text,
  -- Email: the template's HTML with scripts, handlers and template tags taken out (shown in a sandboxed iframe)
  html         text,
  -- SMS: the message text; email: the plain-text version
  body         text,
  fetched_at   timestamptz not null default now(),
  primary key (client_id, campaign_id)
);
alter table public.klaviyo_previews enable row level security;
drop policy if exists "staff read klaviyo previews" on public.klaviyo_previews;
create policy "staff read klaviyo previews" on public.klaviyo_previews for select to authenticated using (private.staff_can_see_client(client_id));

-- 4. List and segment sizes over time
create table if not exists public.klaviyo_audience_sizes (
  client_id      uuid not null references public.clients (id) on delete cascade,
  audience_id    text not null,
  date           date not null,
  profile_count  bigint not null,
  primary key (client_id, audience_id, date)
);
alter table public.klaviyo_audience_sizes enable row level security;
drop policy if exists "staff read klaviyo audience sizes" on public.klaviyo_audience_sizes;
create policy "staff read klaviyo audience sizes" on public.klaviyo_audience_sizes for select to authenticated using (private.staff_can_see_client(client_id));

comment on column public.klaviyo_daily.store_revenue is 'The store''s total revenue that day as Klaviyo sees it: the Placed Order metric''s sum of value (metric aggregates)';
comment on table public.klaviyo_previews is 'Klaviyo campaign previews (sanitized email HTML or SMS text), cached; read only';
