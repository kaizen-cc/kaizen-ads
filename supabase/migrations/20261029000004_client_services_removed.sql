-- Services taken off a client in Kaizen Ads, Kaizen Track's included (Track's hourly mirror doesn't bring them back)
alter table public.clients add column if not exists services_removed text[] not null default '{}';
