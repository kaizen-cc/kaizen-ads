-- Settings › AI agents › Knowledge, part two.
-- 1. Pre-sale audits: many of the senior buyer's Looms are audits of a sales prospect's account. The strategy he gives
--    is taught to the buyers like any method video, and the prospect is kept on the video (name, website, ad account,
--    business), suggested by the AI when it sorts the video. When the prospect becomes a client (enrolled, matched
--    daily by name, website or ad account, or picked by hand), every Loom about them is filed to the new client as a
--    pre-sale audit, and the go-to-market strategy reads them.
-- 2. Contradictions in the senior buyer's teachings go to the people who can rule on audits (profiles.can_rebut_audits)
--    as a bell alert; each one opens a review sheet with a chat with the Media Buyer or Google Ads Buyer, kept here.
-- Nothing is deleted.

alter table public.loom_videos add column if not exists thumbnail_url text;
-- What the AI suggested when it sorted the video: is it an audit of a prospect (not a client yet), and who
alter table public.loom_videos add column if not exists prospect_suggested jsonb;
alter table public.loom_videos add column if not exists prospect_suggested_at timestamptz;
-- The prospect as decided by the team: prospect (not a client yet) · client (became one: prospect_client_id)
alter table public.loom_videos add column if not exists prospect_status text check (prospect_status in ('prospect', 'client'));
alter table public.loom_videos add column if not exists prospect_name text;
alter table public.loom_videos add column if not exists prospect_domain text;
alter table public.loom_videos add column if not exists prospect_ad_account text;
alter table public.loom_videos add column if not exists prospect_business text;
alter table public.loom_videos add column if not exists prospect_client_id uuid references public.clients(id) on delete set null;
alter table public.loom_videos add column if not exists prospect_attached_at timestamptz;
-- Set when someone decides a video is method (not about a client): the worker distills it without sorting it again
alter table public.loom_videos add column if not exists forced_kind text check (forced_kind in ('method'));
alter table public.loom_videos add column if not exists decided_by uuid references public.profiles(id) on delete set null;
alter table public.loom_videos add column if not exists decided_at timestamptz;
create index if not exists loom_videos_prospect on public.loom_videos (prospect_status) where prospect_status is not null;
create index if not exists loom_videos_prospect_client on public.loom_videos (prospect_client_id) where prospect_client_id is not null;

-- When the people who rule on contradictions were told about this one
alter table public.media_buying_insights add column if not exists notified_at timestamptz;
-- A refined rule taught from a contradiction's review: the two items it settles
alter table public.media_buying_insights add column if not exists refined_from uuid[];

-- The review chat on one contradiction: the senior buyer (or an exec) and the Media Buyer or Google Ads Buyer
create table if not exists public.insight_conflict_messages (
  id          uuid primary key default gen_random_uuid(),
  insight_id  uuid not null references public.media_buying_insights(id) on delete cascade,
  role        text not null check (role in ('person', 'agent')),
  body        text not null,
  -- The agent's proposed refined rule, once the person has made the call; taught_at when it was saved as a point
  proposal    text,
  taught_at   timestamptz,
  taught_by   uuid references public.profiles(id) on delete set null,
  author_id   uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists insight_conflict_messages_insight on public.insight_conflict_messages (insight_id, created_at);
alter table public.insight_conflict_messages enable row level security;
drop policy if exists "staff read contradiction chats" on public.insight_conflict_messages;
create policy "staff read contradiction chats" on public.insight_conflict_messages for select to authenticated using (private.is_staff());

-- The bell: a contradiction to rule on is an alert for the people who can rule
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
