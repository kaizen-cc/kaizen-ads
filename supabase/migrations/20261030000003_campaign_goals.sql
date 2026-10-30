-- What each campaign is optimized for (from its ad sets), so a KPI can count each campaign by its own goal
create table if not exists public.campaign_goals (
  platform text not null default 'meta',
  ad_account_id text not null,
  campaign_id text not null,
  optimization_goal text,
  event text,
  label text,
  actions text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (platform, ad_account_id, campaign_id)
);
alter table public.campaign_goals enable row level security;
create policy "staff read campaign goals" on public.campaign_goals for select using (private.current_profile_id() is not null);
