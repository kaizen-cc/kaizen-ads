-- Changes asked for in a chat (the client desk on the client page, the same desk on the KPI board): the ask is kept with
-- the plan the buyer agent made from the live account, what the person confirmed and what came back. A change to the
-- client's media buyer goes through the same log (platform 'team', no ad account).
alter table public.ad_changes alter column target_id drop not null;
alter table public.ad_changes drop constraint if exists ad_changes_source_check;
alter table public.ad_changes add constraint ad_changes_source_check check (source in ('audit', 'sprint', 'chat'));
alter table public.ad_changes add column if not exists request text;
alter table public.ad_changes add column if not exists asked_by uuid references public.profiles(id) on delete set null;
alter table public.ad_changes add column if not exists saved_at timestamptz;
create index if not exists ad_changes_client_chat on public.ad_changes (client_id, created_at desc) where source = 'chat';
