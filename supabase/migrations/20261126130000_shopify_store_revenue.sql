-- Shopify: each client's real store revenue and orders, a day at a time, as far back as the store goes.
-- One row per client, store and day that had orders (a day with no row inside the store's read history is a $0 day).
-- Written only when a day's numbers change (see src/lib/unchanged.ts): the full-history read and the hourly refresh
-- compare with what's stored first.

create table if not exists public.shopify_daily (
  client_id uuid not null references public.clients(id) on delete cascade,
  shop text not null,
  date date not null,
  orders integer not null default 0,
  gross_sales numeric(14,2) not null default 0,
  discounts numeric(14,2) not null default 0,
  refunds numeric(14,2) not null default 0,
  net_sales numeric(14,2) not null default 0,
  shipping numeric(14,2) not null default 0,
  taxes numeric(14,2) not null default 0,
  total_sales numeric(14,2) not null default 0,
  new_customers integer not null default 0,
  returning_customers integer not null default 0,
  -- where orders came from: { "<channel>": { "orders": n, "sales": x } } (online store, POS, Meta, Google, …)
  by_channel jsonb not null default '{}'::jsonb,
  currency text,
  updated_at timestamptz not null default now(),
  primary key (client_id, shop, date)
);

create index if not exists shopify_daily_client_date on public.shopify_daily (client_id, date);

alter table public.shopify_daily enable row level security;
drop policy if exists "staff read shopify daily" on public.shopify_daily;
create policy "staff read shopify daily" on public.shopify_daily for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

-- Clients that sell on Shopify (their site, their Klaviyo's Placed Order, their onboarding answers) but aren't connected
create table if not exists public.client_store_hints (
  client_id uuid primary key references public.clients(id) on delete cascade,
  platform text,
  shop_domain text,
  evidence text[] not null default '{}',
  checked_at timestamptz not null default now()
);
alter table public.client_store_hints enable row level security;
drop policy if exists "staff read store hints" on public.client_store_hints;
create policy "staff read store hints" on public.client_store_hints for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

-- When the client started with Kaizen (the line case studies split before and after). Null: read from their first ad spend.
alter table public.clients add column if not exists kaizen_started_on date;

-- Every ad dollar a client spent, a day and platform at a time (Meta, Google, TikTok), from the accounts on their KPI
-- board: the bottom of MER (store revenue over total ad spend). Server only.
create or replace function public.client_ad_spend_daily(p_client uuid, p_from date, p_to date)
returns table (date date, platform text, spend numeric)
language sql stable
set search_path = public
as $$
  with acc as (
    select distinct platform, ad_account_id from public.kpi_targets
    where client_id = p_client and ad_account_id is not null and platform in ('meta', 'google', 'tiktok')
  )
  select d.date, 'meta'::text, sum(d.spend) from public.meta_campaign_daily d
    where d.ad_account_id in (select ad_account_id from acc where platform = 'meta') and d.date between p_from and p_to group by d.date
  union all
  select d.date, 'google'::text, sum(d.spend) from public.google_campaign_daily d
    where d.ad_account_id in (select ad_account_id from acc where platform = 'google') and d.date between p_from and p_to group by d.date
  union all
  select d.date, 'tiktok'::text, sum(d.spend) from public.tiktok_campaign_daily d
    where d.ad_account_id in (select ad_account_id from acc where platform = 'tiktok') and d.date between p_from and p_to group by d.date
$$;
revoke all on function public.client_ad_spend_daily(uuid, date, date) from public, anon, authenticated;
grant execute on function public.client_ad_spend_daily(uuid, date, date) to service_role;
