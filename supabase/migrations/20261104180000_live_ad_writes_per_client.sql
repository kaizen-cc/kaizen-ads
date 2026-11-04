-- Live changes in a client's ad accounts, switched on per client by an exec: while the global sandbox is on, Kaizen Ads
-- writes only to Kaizen's own account and to the accounts of clients switched on here (testing client by client first)
alter table public.clients add column if not exists live_ad_writes boolean not null default false;
alter table public.clients add column if not exists live_ad_writes_by uuid references public.profiles(id) on delete set null;
alter table public.clients add column if not exists live_ad_writes_at timestamptz;
