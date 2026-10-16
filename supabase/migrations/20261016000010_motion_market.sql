-- Motion (motionapp.com): Kaizen's one Motion account, connected over Motion's MCP server with OAuth. Server only:
-- no one reads the tokens from the browser.
create table public.motion_connection (
  id             smallint primary key default 1 check (id = 1),
  client_id      text,                  -- this app, registered with Motion (dynamic client registration)
  access_token   text,
  refresh_token  text,
  expires_at     timestamptz,
  connected_by   uuid references public.profiles(id) on delete set null,
  connected_at   timestamptz,
  tools          jsonb not null default '[]', -- Motion's tools and their inputs, as Motion describes them
  workspace      jsonb,
  last_sync_at   timestamptz,
  last_result    jsonb,
  error          text
);
alter table public.motion_connection enable row level security;

-- The market: brands we watch per industry (Motion-tracked competitors, competitors named by clients, top brands
-- Motion finds), and their live ads. Everyone on the team sees it.
create table public.market_brands (
  id               uuid primary key default gen_random_uuid(),
  motion_brand_id  text not null unique,
  name             text not null,
  domain           text,
  logo             text,
  industry         text,
  industry_detail  text,
  sources          text[] not null default '{}', -- motion, intake, gtm, search
  client_ids       uuid[] not null default '{}', -- clients who named them as a competitor
  active_ads       int,
  last_synced_at   timestamptz,
  created_at       timestamptz not null default now()
);
create index market_brands_industry on public.market_brands (industry);

create table public.market_ads (
  id             uuid primary key default gen_random_uuid(),
  motion_id      text not null unique,
  brand_id       uuid not null references public.market_brands(id) on delete cascade,
  industry       text,
  format         text,           -- image, video, carousel
  headline       text,
  body           text,
  cta            text,
  landing_url    text,
  launched_at    timestamptz,
  active         boolean,
  days_active    int,
  media          jsonb not null default '[]', -- [{ type, url, thumb }]
  motion_url     text,           -- the item in Motion, for the creative team
  raw            jsonb,
  angle          text,           -- the AI's read
  hook           text,
  why            text,
  tags           text[] not null default '{}',
  read_at        timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create index market_ads_industry on public.market_ads (industry, active, days_active desc);
create index market_ads_brand on public.market_ads (brand_id);

alter table public.market_brands enable row level security;
alter table public.market_ads enable row level security;
create policy "staff read market brands" on public.market_brands for select to authenticated using (private.is_staff());
create policy "staff read market ads" on public.market_ads for select to authenticated using (private.is_staff());

-- A brief built on a market ad
alter table public.creative_suggestions drop constraint if exists creative_suggestions_kind_check;
alter table public.creative_suggestions add constraint creative_suggestions_kind_check check (kind in ('fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab', 'winner', 'refresh', 'onboarding', 'call', 'market'));
drop index if exists public.creative_suggestions_one_open;
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id) where status = 'open' and kind not in ('lab', 'winner', 'refresh', 'onboarding', 'call', 'market');

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('market', 'Market reader', 'Reads the live ads Motion pulls from brands in each industry: the angle, the hook and why it works, so buyers and the strategist can build on what''s out in the market.', 'sonnet', 'low', true, 16, 'eye', '{}')
on conflict (key) do nothing;
