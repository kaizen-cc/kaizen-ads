create table if not exists public.google_ideas (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  account text not null,
  kind text not null check (kind in ('ad', 'keyword', 'search_term')),
  key text not null,
  campaign text,
  ad_group text,
  content jsonb not null default '{}'::jsonb,
  spend numeric not null default 0,
  clicks numeric not null default 0,
  impressions numeric not null default 0,
  conversions numeric not null default 0,
  value numeric not null default 0,
  roas boolean not null default false,
  result numeric,
  usual numeric,
  basis text not null default 'account',
  beat_by numeric not null default 0,
  live boolean not null default false,
  live_result numeric,
  live_beat_by numeric,
  fame boolean not null default false,
  qualified_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '182 days',
  insight jsonb,
  insight_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (client_id, kind, key)
);
comment on table public.google_ideas is 'Google Ads winners across our clients: ads (RSA copy), keywords and search terms that beat their target or their account. fame: the Hall of Fame (180 days, kept six months); live: winning over the last 30 days and still running';
alter table public.google_ideas enable row level security;
create policy "staff read google ideas" on public.google_ideas for select to authenticated using (private.is_staff());
create index if not exists google_ideas_fame on public.google_ideas (fame, expires_at desc);
create index if not exists google_ideas_live on public.google_ideas (live);
