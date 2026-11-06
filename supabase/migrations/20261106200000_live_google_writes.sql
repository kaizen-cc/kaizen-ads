-- Live changes in a client's Google Ads account, switched on per client by an exec, on its own: live_ad_writes is now
-- Meta only. Off for every client to start (nobody's Meta switch carries over); nothing is written to a Google Ads
-- account until an exec switches this on for its client in Team & setup.
alter table public.clients add column if not exists live_google_writes boolean not null default false;
alter table public.clients add column if not exists live_google_writes_at timestamptz;
alter table public.clients add column if not exists live_google_writes_by uuid references public.profiles(id) on delete set null;

comment on column public.clients.live_ad_writes is 'Live changes in this client''s Meta ad accounts (switched on by an exec in Team & setup)';
comment on column public.clients.live_google_writes is 'Live changes in this client''s Google Ads account (switched on by an exec in Team & setup)';

-- The old "Google writes for everyone" switch (Settings, Sync health) no longer opens anything: every Google write needs
-- the client's own switch
delete from public.app_settings where key = 'google_write';
