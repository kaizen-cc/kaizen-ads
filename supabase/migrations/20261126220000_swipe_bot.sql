-- The swipe bot (owner, Nov 25 2026): Kaizen subscribes to the best brands' email flows (not only newsletters) and keeps
-- every email as it arrives. One Kaizen mailbox (the swipe@ alias; each brand signs up as swipe+<slug>@ so every email maps
-- to its brand), read through the Workspace's domain-wide delegation. A headless browser runner (GitHub Actions; Vercel
-- functions can't hold a browser that long) signs each brand up and triggers its welcome, browse-abandon, cart-abandon and
-- checkout-started flows. It never buys, never solves or bypasses a CAPTCHA (the brand is marked "needs a human signup"
-- and the email lead gets an item), respects robots.txt and rate limits, and keeps one identity per brand.
--   swipe_brands  the brands followed: seeded (top brands per vertical), prospects and their competitors, or added
--   swipe_events  what the runner did for a brand (signed up, browsed, carted, started checkout, needs a human), when
--   swipe_emails  every email: brand, sender, subject, preheader, received_at, hours after its trigger, flow type,
--                 offer, CTA, SMS opt-in ask, the HTML and a screenshot (Storage, bucket "swipe")
--   swipe_flows   emails grouped into flows (welcome, browse, cart, checkout, winback, campaign) with step numbers and the
--                 time between steps

create table if not exists public.swipe_brands (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique check (slug ~ '^[a-z0-9]{2,40}$'),
  name           text not null,
  website        text not null,
  vertical       text not null,
  source         text not null default 'seed' check (source in ('seed', 'prospect', 'competitor', 'manual')),
  prospect_id    uuid references public.prospects (id) on delete set null,
  status         text not null default 'new' check (status in ('new', 'subscribed', 'active', 'needs_human', 'silent', 'retired', 'paused')),
  platform       text,
  session        jsonb,
  signed_up_at   timestamptz,
  browsed_at     timestamptz,
  carted_at      timestamptz,
  checkout_at    timestamptz,
  last_email_at  timestamptz,
  emails         integer not null default 0,
  note           text,
  added_by       uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists swipe_brands_status on public.swipe_brands (status, updated_at);

create table if not exists public.swipe_events (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references public.swipe_brands (id) on delete cascade,
  kind        text not null check (kind in ('signup', 'confirm', 'browse', 'cart', 'checkout', 'needs_human', 'blocked', 'error')),
  ok          boolean not null default true,
  detail      text,
  at          timestamptz not null default now()
);
create index if not exists swipe_events_brand on public.swipe_events (brand_id, at desc);

create table if not exists public.swipe_flows (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references public.swipe_brands (id) on delete cascade,
  flow_type   text not null check (flow_type in ('welcome', 'browse', 'cart', 'checkout', 'winback', 'campaign', 'transactional', 'other')),
  started_at  timestamptz not null,
  steps       integer not null default 0,
  cadence     text,
  offers      text,
  updated_at  timestamptz not null default now(),
  unique (brand_id, flow_type, started_at)
);

create table if not exists public.swipe_emails (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid references public.swipe_brands (id) on delete set null,
  gmail_id      text not null unique,
  to_address    text,
  sender        text,
  subject       text,
  preheader     text,
  received_at   timestamptz not null,
  trigger_kind  text,
  offset_hours  numeric(8, 2),
  flow_type     text check (flow_type in ('welcome', 'browse', 'cart', 'checkout', 'winback', 'campaign', 'transactional', 'other')),
  flow_id       uuid references public.swipe_flows (id) on delete set null,
  step          integer,
  offer         text,
  cta           text,
  sms_ask       boolean,
  summary       text,
  html_path     text,
  shot_path     text,
  created_at    timestamptz not null default now()
);
create index if not exists swipe_emails_brand on public.swipe_emails (brand_id, received_at desc);
create index if not exists swipe_emails_type on public.swipe_emails (flow_type, received_at desc);

alter table public.swipe_brands enable row level security;
alter table public.swipe_events enable row level security;
alter table public.swipe_flows enable row level security;
alter table public.swipe_emails enable row level security;
drop policy if exists "staff read swipe brands" on public.swipe_brands;
create policy "staff read swipe brands" on public.swipe_brands for select to authenticated using ((select private.is_staff()));
drop policy if exists "staff read swipe events" on public.swipe_events;
create policy "staff read swipe events" on public.swipe_events for select to authenticated using ((select private.is_staff()));
drop policy if exists "staff read swipe flows" on public.swipe_flows;
create policy "staff read swipe flows" on public.swipe_flows for select to authenticated using ((select private.is_staff()));
drop policy if exists "staff read swipe emails" on public.swipe_emails;
create policy "staff read swipe emails" on public.swipe_emails for select to authenticated using ((select private.is_staff()));
grant select on public.swipe_brands, public.swipe_events, public.swipe_flows, public.swipe_emails to authenticated;

insert into storage.buckets (id, name, public) values ('swipe', 'swipe', false) on conflict (id) do nothing;

-- The seed: top brands per vertical (ecommerce first, then the local service verticals Kaizen serves)
insert into public.swipe_brands (slug, name, website, vertical) values
('glossier', 'Glossier', 'https://www.glossier.com', 'ecommerce · beauty'),
('kosas', 'Kosas', 'https://kosas.com', 'ecommerce · beauty'),
('summerfridays', 'Summer Fridays', 'https://summerfridays.com', 'ecommerce · skincare'),
('drunkelephant', 'Drunk Elephant', 'https://www.drunkelephant.com', 'ecommerce · skincare'),
('skims', 'SKIMS', 'https://skims.com', 'ecommerce · apparel'),
('vuori', 'Vuori', 'https://vuoriclothing.com', 'ecommerce · apparel'),
('trueclassic', 'True Classic', 'https://www.trueclassictees.com', 'ecommerce · apparel'),
('cuts', 'Cuts Clothing', 'https://www.cutsclothing.com', 'ecommerce · apparel'),
('quince', 'Quince', 'https://www.quince.com', 'ecommerce · apparel'),
('allbirds', 'Allbirds', 'https://www.allbirds.com', 'ecommerce · footwear'),
('ag1', 'AG1', 'https://drinkag1.com', 'ecommerce · supplements'),
('ritual', 'Ritual', 'https://ritual.com', 'ecommerce · supplements'),
('liquidiv', 'Liquid I.V.', 'https://www.liquid-iv.com', 'ecommerce · supplements'),
('olipop', 'OLIPOP', 'https://drinkolipop.com', 'ecommerce · food & beverage'),
('magicspoon', 'Magic Spoon', 'https://magicspoon.com', 'ecommerce · food & beverage'),
('graza', 'Graza', 'https://www.graza.co', 'ecommerce · food & beverage'),
('trade', 'Trade Coffee', 'https://www.drinktrade.com', 'ecommerce · coffee'),
('farmersdog', 'The Farmer''s Dog', 'https://www.thefarmersdog.com', 'ecommerce · pet'),
('barkbox', 'BarkBox', 'https://www.barkbox.com', 'ecommerce · pet'),
('brooklinen', 'Brooklinen', 'https://www.brooklinen.com', 'ecommerce · home'),
('caraway', 'Caraway', 'https://www.carawayhome.com', 'ecommerce · home'),
('ruggable', 'Ruggable', 'https://ruggable.com', 'ecommerce · home'),
('laseraway', 'LaserAway', 'https://www.laseraway.com', 'local · med spa'),
('idealimage', 'Ideal Image', 'https://www.idealimage.com', 'local · med spa'),
('aspendental', 'Aspen Dental', 'https://www.aspendental.com', 'local · dental'),
('orangetheory', 'Orangetheory Fitness', 'https://www.orangetheory.com', 'local · fitness'),
('sweetgreen', 'sweetgreen', 'https://www.sweetgreen.com', 'local · restaurant'),
('mrrooter', 'Mr. Rooter Plumbing', 'https://www.mrrooter.com', 'local · home services')
on conflict (slug) do nothing;

-- The links in each email (the runner opens one from the welcome email before browsing, so the brand knows who it is)
alter table public.swipe_emails add column if not exists links text[] not null default '{}';
