-- The services each client buys, mirrored hourly from Kaizen Track (slugs: facebook-ads, tiktok-ads, google-ads,
-- creative, email-marketing, social-media, web-design, crm…). paid_ads: they buy Meta or TikTok ads from us, so the
-- paid ads team's verticals, playbooks and strategies are about them; creative or email alone doesn't count.
-- Clients not linked to Kaizen Track yet (no services read): paid when they have a Meta ad account.
alter table public.clients
  add column services text[] not null default '{}',
  add column services_synced_at timestamptz;
alter table public.clients add column paid_ads boolean generated always as (
  'facebook-ads' = any(services) or 'tiktok-ads' = any(services) or (services_synced_at is null and meta_ad_account_id is not null)
) stored;
create index if not exists clients_paid_ads_idx on public.clients (paid_ads) where archived_at is null;
-- Verticals are the paid ads team's: clients who don't buy paid ads come out of them
update public.clients set vertical_id = null, vertical_why = null where not paid_ads and vertical_id is not null;
