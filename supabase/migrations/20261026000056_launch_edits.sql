-- Launched ads managed from Kaizen Ads: each edit a buyer makes is kept on the launch, and an edit's reason is learned
-- like a move's (via 'edit')
alter table public.launches add column if not exists edits jsonb not null default '[]'::jsonb;
alter table public.launch_rules drop constraint if exists launch_rules_via_check;
alter table public.launch_rules add constraint launch_rules_via_check check (via in ('app', 'ads_manager', 'edit'));
