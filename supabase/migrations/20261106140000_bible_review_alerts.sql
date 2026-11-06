-- Brand Bibles ready for the creative team's review: the Head of Creative and the client's designer and editor are
-- told when a Bible finishes writing (tagged with whether it was built from the marketing intake form), each marks it
-- reviewed for themselves, and a busy day becomes one digest instead of a flood.

alter table public.client_brand_bibles
  add column if not exists build_reason text,
  add column if not exists built_from_intake boolean,
  add column if not exists content_hash text,
  add column if not exists ready_for_review_at timestamptz;

comment on column public.client_brand_bibles.build_reason is 'Why the last build ran: new, intake (a new intake form), monthly (the automatic refresh) or manual';
comment on column public.client_brand_bibles.built_from_intake is 'Whether the client''s marketing intake form was in when this version was written';
comment on column public.client_brand_bibles.content_hash is 'A hash of what the team reads (Read this first, the cover, open questions): a monthly refresh that leaves it unchanged tells no one';
comment on column public.client_brand_bibles.ready_for_review_at is 'When the creative team was last told this Bible is ready for their review';

-- Who has reviewed which version, one row per person
create table if not exists public.brand_bible_reviews (
  client_id   uuid not null references public.clients (id) on delete cascade,
  version     text not null,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  reviewed_at timestamptz not null default now(),
  primary key (client_id, version, profile_id)
);
create index if not exists brand_bible_reviews_profile on public.brand_bible_reviews (profile_id);
alter table public.brand_bible_reviews enable row level security;
drop policy if exists brand_bible_reviews_read on public.brand_bible_reviews;
create policy brand_bible_reviews_read on public.brand_bible_reviews for select to authenticated
  using (private.staff_can_see_client(client_id));
drop policy if exists brand_bible_reviews_mark on public.brand_bible_reviews;
create policy brand_bible_reviews_mark on public.brand_bible_reviews for insert to authenticated
  with check (profile_id = private.current_profile_id() and private.staff_can_see_client(client_id));

-- The bell: a Brand Bible ready for review (and the day's digest of them) is an alert. Every existing prefix is kept
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'bible-review', 'bible-digest')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
