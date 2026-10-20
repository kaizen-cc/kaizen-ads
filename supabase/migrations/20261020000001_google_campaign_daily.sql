-- Google Ads numbers per campaign per day, the same shape as Meta's (meta_campaign_daily) so the KPI math is shared:
-- spend, impressions, clicks (as link clicks), and conversions with their value under "conversions" plus one entry per
-- conversion action ("action:<name>") for targets that count a specific one.
create table public.google_campaign_daily (
  ad_account_id      text not null,
  campaign_id        text not null,
  date               date not null,
  campaign_name      text,
  campaign_type      text,
  spend              numeric not null default 0,
  impressions        bigint not null default 0,
  clicks             bigint not null default 0,
  link_clicks        bigint not null default 0,
  unique_link_clicks bigint not null default 0,
  actions            jsonb not null default '{}',
  action_values      jsonb not null default '{}',
  updated_at         timestamptz not null default now(),
  primary key (ad_account_id, campaign_id, date)
);
create index on public.google_campaign_daily (ad_account_id, date);
alter table public.google_campaign_daily enable row level security;
create policy "staff read google days" on public.google_campaign_daily for select to authenticated using (private.is_staff());
