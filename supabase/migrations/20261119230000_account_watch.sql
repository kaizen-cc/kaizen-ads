-- Account watch (from the C-suite account review: a client billed for Google for months with no Google spend, Meta
-- spend that stopped unnoticed, a creative package shown on a client who isn't on one, an unknown name in a buyer's
-- change history).
-- 1. clients.billed_services: what Stripe bills each client for, as Kaizen Track keeps it (read hourly by the Track
--    mirror; Stripe and Track are never changed): { "google-ads": { "last": iso, "amount": 875 }, ... }.
-- 2. profiles.platform_aliases: the names a team member shows under in Meta's activity log and Google's change history.
-- 3. watch_pauses: a service intentionally paused until a day, with the reason (a seasonal business), set by a lead or
--    exec; the billed-but-idle check leaves it alone until then.
-- 4. watch_flags: what the daily watch found, open until it clears (activity resumes, the service is removed, a pause
--    is set): billed but idle, neglected, overtouched, spend spikes, drops and overspend, creative behind, a creative
--    sprint worth suggesting, an unrecognized person in an account.
-- 5. watch_actors: a change-history name an exec placed (the client's own person, an outside partner or tool).
-- 6. The bell: 'watch' notifications are alerts. Every existing prefix is kept.
-- Staff who see the client read flags and pauses (checked once per query); the server writes with the service key.

alter table public.clients
  add column if not exists billed_services jsonb not null default '{}'::jsonb,
  add column if not exists billed_synced_at timestamptz;
comment on column public.clients.billed_services is 'Services Stripe billed in the last 45 days (via Kaizen Track): { slug: { last, amount } }';

alter table public.profiles add column if not exists platform_aliases text[] not null default '{}';
comment on column public.profiles.platform_aliases is 'Names this person shows under in Meta and Google change history';

create table if not exists public.watch_pauses (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  service     text not null,
  until       date not null,
  reason      text not null,
  set_by      uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  cleared_at  timestamptz,
  cleared_by  uuid references public.profiles (id) on delete set null
);
create index if not exists watch_pauses_open on public.watch_pauses (client_id, service) where cleared_at is null;
alter table public.watch_pauses enable row level security;
drop policy if exists "staff read watch pauses" on public.watch_pauses;
create policy "staff read watch pauses" on public.watch_pauses for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

create table if not exists public.watch_flags (
  id            uuid primary key default gen_random_uuid(),
  key           text not null,
  kind          text not null check (kind in ('idle', 'neglected', 'overtouched', 'spend_spike', 'spend_drop', 'spend_stopped', 'overspend', 'creative_behind', 'creative_quiet', 'creative_sprint', 'unrecognized')),
  client_id     uuid not null references public.clients (id) on delete cascade,
  line          text,
  account       text,
  title         text not null,
  body          text,
  detail        jsonb not null default '{}'::jsonb,
  severity      text not null default 'warn' check (severity in ('critical', 'warn', 'info')),
  opened_at     timestamptz not null default now(),
  seen_at       timestamptz not null default now(),
  notified_at   timestamptz,
  escalated_at  timestamptz,
  resolved_at   timestamptz,
  resolution    text,
  resolved_by   uuid references public.profiles (id) on delete set null
);
create unique index if not exists watch_flags_open_key on public.watch_flags (key) where resolved_at is null;
create index if not exists watch_flags_client_open on public.watch_flags (client_id) where resolved_at is null;
alter table public.watch_flags enable row level security;
drop policy if exists "staff read watch flags" on public.watch_flags;
create policy "staff read watch flags" on public.watch_flags for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

create table if not exists public.watch_actors (
  name_key    text primary key,
  name        text not null,
  status      text not null check (status in ('client', 'partner')),
  client_id   uuid references public.clients (id) on delete cascade,
  note        text,
  decided_by  uuid references public.profiles (id) on delete set null,
  decided_at  timestamptz not null default now()
);
alter table public.watch_actors enable row level security;
drop policy if exists "staff read watch actors" on public.watch_actors;
create policy "staff read watch actors" on public.watch_actors for select to authenticated using ((select private.is_staff()));

-- ─── The bell: account watch alerts. Every existing prefix is kept
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'feedback-review', 'feedback-reply', 'bible-review', 'bible-digest', 'client-wait', 'connector-ask', 'connector-ready', 'connector-declined', 'direction', 'watch')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;

-- ─── What the daily watch reads in one go (the server only) ────────────────
-- The last day with activity per ad account (spend), per client (creative delivered, an email campaign sent, a post)
create or replace function public.watch_last_activity()
returns table (line text, ref text, last_on date)
language sql stable set search_path = '' as $$
  select 'meta', ad_account_id, max(date) from public.meta_campaign_daily where spend > 0 group by ad_account_id
  union all select 'google', ad_account_id, max(date) from public.google_campaign_daily where spend > 0 group by ad_account_id
  union all select 'tiktok', ad_account_id, max(date) from public.tiktok_campaign_daily where spend > 0 group by ad_account_id
  union all select 'creative', client_id::text, max((completed_at at time zone 'America/New_York')::date) from public.requests where completed_at is not null and deleted_at is null and client_id is not null group by client_id
  union all select 'creative', client_id::text, max((coalesce(completed_at, counted_at) at time zone 'America/New_York')::date) from public.asana_tasks where coalesce(completed_at, counted_at) is not null and client_id is not null group by client_id
  union all select 'email', client_id::text, max((send_time at time zone 'America/New_York')::date) from public.klaviyo_campaigns where send_time <= now() and recipients > 0 group by client_id
  union all select 'email', client_id::text, max(date) from public.klaviyo_daily where campaigns_sent > 0 group by client_id
  union all select 'social', client_id::text, max((posted_at at time zone 'America/New_York')::date) from public.social_posts where posted_at is not null group by client_id
$$;

-- Spend per ad account per day since a day (campaigns added together)
create or replace function public.watch_spend_days(p_since date)
returns table (platform text, ad_account_id text, date date, spend numeric)
language sql stable set search_path = '' as $$
  select 'meta', ad_account_id, date, sum(spend) from public.meta_campaign_daily where date >= p_since group by ad_account_id, date
  union all select 'google', ad_account_id, date, sum(spend) from public.google_campaign_daily where date >= p_since group by ad_account_id, date
  union all select 'tiktok', ad_account_id, date, sum(spend) from public.tiktok_campaign_daily where date >= p_since group by ad_account_id, date
$$;

-- Every name in the change history since a day, with how often and where (for seeding aliases and the people check)
create or replace function public.watch_actor_names(p_since timestamptz)
returns table (who text, platform text, changes bigint, accounts text[])
language sql stable set search_path = '' as $$
  select who, platform, count(*), array_agg(distinct ad_account_id) from public.ad_account_changes where at >= p_since and who is not null group by who, platform
$$;

revoke all on function public.watch_last_activity() from public, anon, authenticated;
revoke all on function public.watch_spend_days(date) from public, anon, authenticated;
revoke all on function public.watch_actor_names(timestamptz) from public, anon, authenticated;
grant execute on function public.watch_last_activity() to service_role;
grant execute on function public.watch_spend_days(date) to service_role;
grant execute on function public.watch_actor_names(timestamptz) to service_role;
