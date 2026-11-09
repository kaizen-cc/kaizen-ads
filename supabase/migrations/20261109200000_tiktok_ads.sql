-- TikTok Ads, the third ad platform next to Meta and Google, read only for now. Dormant until TIKTOK_APP_ID and
-- TIKTOK_APP_SECRET are set in Vercel (Kaizen's TikTok Marketing API app): nothing reads or writes these tables before.
--
-- An exec connects TikTok from Settings > Sync health > TikTok (OAuth: TikTok asks the person to authorize Kaizen's app
-- for the ad accounts they pick). The long-lived access token is encrypted by the app (AES-256-GCM, key in
-- TOKEN_ENCRYPTION_KEY, the same helper as the Business Managers' Meta tokens): iv, auth tag and ciphertext, base64.
-- Never readable from the browser: RLS is on with no policies on the connection, so only the server (service role)
-- reads it. Everyone on a client reads its TikTok numbers the way they read Meta's and Google's.
--
-- Additive and idempotent: safe to run more than once.

-- 1. The KPI board takes TikTok targets (ad_account_id = the TikTok advertiser_id)
alter table public.kpi_targets drop constraint if exists kpi_targets_platform_check;
alter table public.kpi_targets add constraint kpi_targets_platform_check check (platform in ('meta', 'google', 'tiktok'));

-- 2. Each authorization: one exec's OAuth grant and the advertisers it reaches
create table if not exists public.tiktok_connections (
  id               uuid primary key default gen_random_uuid(),
  advertiser_ids   text[] not null default '{}',
  token_iv         text,
  token_tag        text,
  token_ciphertext text,
  token_last4      text,
  scopes           text[] not null default '{}',
  connected_by     uuid references public.profiles (id) on delete set null,
  connected_at     timestamptz not null default now(),
  last_checked_at  timestamptz,
  -- active: in use · replaced: a newer grant covers its advertisers · invalid: TikTok refused the token · revoked: disconnected
  status           text not null default 'active' check (status in ('active', 'replaced', 'invalid', 'revoked')),
  last_error       text,
  constraint tiktok_connections_cipher check (status in ('revoked', 'replaced') or (token_iv is not null and token_tag is not null and token_ciphertext is not null))
);
create index if not exists tiktok_connections_status on public.tiktok_connections (status, connected_at desc);
alter table public.tiktok_connections enable row level security;
revoke all on public.tiktok_connections from anon, authenticated;

-- 3. Every advertiser (ad account) a connection reaches, and the client it belongs to
create table if not exists public.tiktok_advertisers (
  advertiser_id   text primary key,
  connection_id   uuid references public.tiktok_connections (id) on delete set null,
  name            text,
  currency        text,
  timezone        text,
  status          text,
  client_id       uuid references public.clients (id) on delete set null,
  linked_at       timestamptz,
  last_synced_at  timestamptz,
  -- The first full pull (90 days) is done: after it only the last days are read again
  backfilled_at   timestamptz,
  error           text,
  updated_at      timestamptz not null default now()
);
create index if not exists tiktok_advertisers_client on public.tiktok_advertisers (client_id) where client_id is not null;
alter table public.tiktok_advertisers enable row level security;
drop policy if exists "staff read tiktok advertisers" on public.tiktok_advertisers;
create policy "staff read tiktok advertisers" on public.tiktok_advertisers for select to authenticated using (private.is_staff());

-- 4. Per campaign per day, the same shape as meta_campaign_daily and google_campaign_daily so the KPI math is shared:
-- clicks as link clicks; actions {tiktok_conversion, tiktok_complete_payment, video_*}; action_values
-- {tiktok_complete_payment: purchase value}. The rest of TikTok's numbers are kept as columns and raw.
create table if not exists public.tiktok_campaign_daily (
  ad_account_id      text not null,
  campaign_id        text not null,
  date               date not null,
  campaign_name      text,
  spend              numeric not null default 0,
  impressions        bigint not null default 0,
  clicks             bigint not null default 0,
  link_clicks        bigint not null default 0,
  unique_link_clicks bigint not null default 0,
  conversions        numeric not null default 0,
  conversion_value   numeric not null default 0,
  purchases          numeric not null default 0,
  video_plays        bigint not null default 0,
  video_2s           bigint not null default 0,
  video_6s           bigint not null default 0,
  avg_play_seconds   numeric,
  reach              bigint not null default 0,
  frequency          numeric,
  actions            jsonb not null default '{}',
  action_values      jsonb not null default '{}',
  raw                jsonb not null default '{}',
  updated_at         timestamptz not null default now(),
  primary key (ad_account_id, campaign_id, date)
);
create index if not exists tiktok_campaign_daily_account on public.tiktok_campaign_daily (ad_account_id, date);
alter table public.tiktok_campaign_daily enable row level security;
drop policy if exists "staff read tiktok days" on public.tiktok_campaign_daily;
create policy "staff read tiktok days" on public.tiktok_campaign_daily for select to authenticated using (private.is_staff());

-- 5. Per ad per day (top ads, hook rates, the client page)
create table if not exists public.tiktok_ad_daily (
  ad_account_id    text not null,
  ad_id            text not null,
  date             date not null,
  ad_name          text,
  campaign_id      text,
  campaign_name    text,
  adgroup_id       text,
  adgroup_name     text,
  spend            numeric not null default 0,
  impressions      bigint not null default 0,
  clicks           bigint not null default 0,
  conversions      numeric not null default 0,
  conversion_value numeric not null default 0,
  purchases        numeric not null default 0,
  video_plays      bigint not null default 0,
  video_2s         bigint not null default 0,
  video_6s         bigint not null default 0,
  avg_play_seconds numeric,
  reach            bigint not null default 0,
  frequency        numeric,
  raw              jsonb not null default '{}',
  updated_at       timestamptz not null default now(),
  primary key (ad_account_id, ad_id, date)
);
create index if not exists tiktok_ad_daily_account on public.tiktok_ad_daily (ad_account_id, date);
alter table public.tiktok_ad_daily enable row level security;
drop policy if exists "staff read tiktok ad days" on public.tiktok_ad_daily;
create policy "staff read tiktok ad days" on public.tiktok_ad_daily for select to authenticated using (private.is_staff());

-- 6. Each ad as it stands: status, text, call to action and its creative's thumbnail
create table if not exists public.tiktok_ads (
  ad_id             text primary key,
  ad_account_id     text not null,
  campaign_id       text,
  adgroup_id        text,
  ad_name           text,
  status            text,
  secondary_status  text,
  ad_text           text,
  call_to_action    text,
  landing_page_url  text,
  video_id          text,
  image_ids         text[] not null default '{}',
  thumbnail_url     text,
  created_at        timestamptz,
  updated_at        timestamptz not null default now()
);
create index if not exists tiktok_ads_account on public.tiktok_ads (ad_account_id);
alter table public.tiktok_ads enable row level security;
drop policy if exists "staff read tiktok ads" on public.tiktok_ads;
create policy "staff read tiktok ads" on public.tiktok_ads for select to authenticated using (private.is_staff());

comment on table public.tiktok_connections is 'TikTok Marketing API grants (OAuth), token encrypted with TOKEN_ENCRYPTION_KEY; server only';
comment on table public.tiktok_advertisers is 'TikTok ad accounts the connection reaches, and the client each belongs to';

-- 7. The TikTok buyer seat (added in 20261109195000_tiktok_buyer_seat.sql): a client's secondary buyers on TikTok are
-- its TikTok seat's, or the Meta seat's while nobody holds a TikTok seat (the Meta buyer buys TikTok until then). Off
-- target alerts (private.notify_kpi) reach them through this. Compared as text so this runs in the same deploy.
create or replace function private.secondary_buyers(p_client uuid, p_platform text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select profile_id from public.client_assignments
   where client_id = p_client and not is_primary
     and role::text = case
       when p_platform = 'google' then 'google_buyer'
       when p_platform = 'tiktok' and exists (select 1 from public.client_assignments x where x.client_id = p_client and x.role::text = 'tiktok_buyer') then 'tiktok_buyer'
       else 'meta_buyer' end
$$;
revoke all on function private.secondary_buyers(uuid, text) from public, anon;

-- 8. The TikTok Ads Buyer agent, shipped offline: an exec brings it online in Settings > AI agents once the Head of Meta
-- has written its skills. Until then no AI path calls its skills (src/lib/ai.ts checks ai_roles.offline first).
alter table public.ai_roles add column if not exists offline boolean not null default false;

insert into public.ai_roles (key, label, description, icon, sort_order, core, offline)
select 'tiktok_buyer', 'TikTok Ads Buyer', 'The TikTok side of media buying: audits TikTok accounts against their KPI, writes TikTok reports and (later) launches. Offline until its skills are written.', 'target', 6,
       'Placeholder: the TikTok Ads Buyer''s core is written by the Head of Meta before it goes online.', true
 where not exists (select 1 from public.ai_roles where key = 'tiktok_buyer');

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select v.key, v.label, v.description, v.model, v.effort, false, v.sort_order, '{}'::jsonb, 'tiktok_buyer', ''
  from (values
    ('tiktok_auditor', 'TikTok account audit', 'Will audit a TikTok ad account against its KPI target (campaigns, ad groups, creative and hook rates, pixel events). Offline: a shell to write.', 'opus', 'high', 70),
    ('tiktok_launcher', 'TikTok launcher', 'Will push approved ads to TikTok, paused, for the buyer to confirm. Offline, and TikTok writes stay off.', 'opus', 'high', 71),
    ('tiktok_reporter', 'TikTok client reports', 'Will draft the weekly and monthly TikTok report in the buyer''s voice. Offline: until then TikTok reports are written by the Meta reporter.', 'opus', 'medium', 72)
  ) as v(key, label, description, model, effort, sort_order)
 where not exists (select 1 from public.ai_agents a where a.key = v.key);

-- 9. Meta and TikTok in one weekly report: a client's TikTok part joins its Meta report (the Meta buyer sends both
-- once: one PDF, one Slack message, one email). On by default; a client's report prefs can send them separately.
alter table public.reports add column if not exists joined_to uuid references public.reports (id) on delete set null;
create index if not exists reports_joined_to on public.reports (joined_to) where joined_to is not null;
alter table public.client_report_prefs add column if not exists tiktok_separate boolean not null default false;
