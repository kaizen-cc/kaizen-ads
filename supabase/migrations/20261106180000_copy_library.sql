-- The Copy library: every primary text, headline and description a client's Meta ads ran, with how it did (added up
-- from the client playbook, not stored here). What's kept: the lines the team starred to reuse (shared per client), and
-- the variations the Copywriter wrote from a proven line, each with why.
create table if not exists public.copy_library_stars (
  client_id uuid not null references public.clients (id) on delete cascade,
  line_key text not null,
  kind text not null check (kind in ('primary', 'headline', 'description')),
  text text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (client_id, line_key)
);
alter table public.copy_library_stars enable row level security;
create policy "staff read copy stars" on public.copy_library_stars for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff star copy" on public.copy_library_stars for insert to authenticated with check (private.staff_can_see_client(client_id));
create policy "staff unstar copy" on public.copy_library_stars for delete to authenticated using (private.staff_can_see_client(client_id));

create table if not exists public.copy_library_variations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  line_key text not null,
  kind text not null check (kind in ('primary', 'headline', 'description')),
  model_text text not null,
  note text,
  variations jsonb not null default '[]', -- [{ text, reason, chars }]
  model text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists copy_library_variations_line on public.copy_library_variations (client_id, line_key, created_at desc);
alter table public.copy_library_variations enable row level security;
create policy "staff read copy variations" on public.copy_library_variations for select to authenticated using (private.staff_can_see_client(client_id));

-- Google's copy for the Copy library: each RSA headline and description (with Google's performance label and pin),
-- sitelink, callout and Performance Max text that ran in the last 90 days, per campaign and ad group, with its numbers.
-- Replaced for an account on each Google ideas run (a light read of ad_group_ad_asset_view, campaign_asset and
-- asset_group_asset); the library judges it on the client's Google KPI.
create table if not exists public.google_copy_assets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  account text not null,
  kind text not null check (kind in ('headline', 'long_headline', 'description', 'sitelink', 'callout')),
  text text not null,
  source text not null check (source in ('rsa', 'pmax', 'campaign')),
  label text,
  pinned text,
  campaign_id text,
  campaign_name text,
  ad_group text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  conversions numeric not null default 0,
  value numeric not null default 0,
  spend numeric not null default 0,
  synced_at timestamptz not null default now()
);
create index if not exists google_copy_assets_client on public.google_copy_assets (client_id, account);
alter table public.google_copy_assets enable row level security;
create policy "staff read google copy" on public.google_copy_assets for select to authenticated using (private.staff_can_see_client(client_id));

-- The library's stars and variations cover Google copy too
alter table public.copy_library_stars drop constraint if exists copy_library_stars_kind_check;
alter table public.copy_library_stars add constraint copy_library_stars_kind_check check (kind in ('primary', 'headline', 'description', 'long_headline', 'sitelink', 'callout'));
alter table public.copy_library_variations drop constraint if exists copy_library_variations_kind_check;
alter table public.copy_library_variations add constraint copy_library_variations_kind_check check (kind in ('primary', 'headline', 'description', 'long_headline', 'sitelink', 'callout'));
alter table public.copy_library_variations add column if not exists platform text not null default 'meta' check (platform in ('meta', 'google'));