-- Launching new Google Ads from the client chat (src/lib/google-launch): a Google run is a launch_runs row with
-- platform 'google' (already allowed), and its lines are the objects it creates: a budget, a campaign, its locations,
-- negatives, sitelinks, callouts and snippets, ad groups, keywords, responsive search ads, Performance Max text. Each
-- deploy is kept in ad_changes (source 'launch') so it shows in the client's change history and activity.

alter table public.launch_items drop constraint if exists launch_items_kind_check;
alter table public.launch_items add constraint launch_items_kind_check check (kind in (
  'campaign', 'adset', 'media', 'creative', 'ad',
  'budget', 'targeting', 'negative', 'extension', 'ad_group', 'keyword', 'rsa', 'pmax_asset'
));

alter table public.ad_changes drop constraint if exists ad_changes_source_check;
alter table public.ad_changes add constraint ad_changes_source_check check (source = any (array['audit', 'sprint', 'chat', 'policy', 'launch']));

create index if not exists launch_runs_platform on public.launch_runs (client_id, platform, created_by, updated_at desc) where status in ('asking', 'ready', 'planning', 'checking');
