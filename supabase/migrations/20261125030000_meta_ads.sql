-- Every Meta ad in a client's account (src/lib/ad-library): status, its ad set's learning phase, and the creative's
-- type, picture and copy, for the client page's Ads tab (all ads, not only the tiring ones). Synced with the daily
-- numbers, writing only rows that changed. Read like the daily numbers: staff who see the client and paid ads.

create table if not exists public.meta_ads (
  ad_id            text primary key,
  client_id        uuid not null references public.clients(id) on delete cascade,
  ad_account_id    text not null,
  name             text not null,
  effective_status text,
  learning         text,
  campaign_id      text,
  campaign_name    text,
  adset_id         text,
  adset_name       text,
  format           text,
  thumbnail_url    text,
  headline         text,
  body             text,
  created_time     timestamptz,
  seen_at          timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists meta_ads_client on public.meta_ads (client_id, effective_status);
alter table public.meta_ads enable row level security;
drop policy if exists "staff read meta ads" on public.meta_ads;
create policy "staff read meta ads" on public.meta_ads for select to authenticated
  using (((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false)) and (select private.sees_paid_ads()));

-- When the Meta sync last read this client's account (success or not): the sync goes oldest first, so every account
-- gets its turn (src/lib/context/meta.ts collectMeta)
alter table public.clients add column if not exists meta_synced_at timestamptz;
