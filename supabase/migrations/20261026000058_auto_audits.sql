-- Audits Kaizen Ads ran on its own (an account in the red), and the switch for applying changes in Google Ads (off
-- until an exec turns it on; Google's dry-run checks still run)
alter table public.account_audits add column if not exists auto boolean not null default false;
insert into public.app_settings (key, value) values ('google_write', '{"enabled": false}'::jsonb) on conflict (key) do nothing;
