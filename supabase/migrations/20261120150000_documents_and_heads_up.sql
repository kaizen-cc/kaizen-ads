-- Two things the assistant does for people:
--
--  1. Branded documents (create_document, for the assistant and Kaizen AI): a Kaizen PDF the agent writes (a Scope of
--     Work, a proposal, a handoff summary, a one-pager), kept with its editable content so it can be changed and drawn
--     again, filed in the client's documents, and attached to client email drafts. Package prices are only ever the
--     stored ones (service_tiers prices here, or what Stripe bills via Kaizen Track): never invented.
--  2. Urgent heads-ups: a critical item for someone (a critical notification, a client's change of direction, an
--     exec's ask due today) is queued here by triggers, so no code path can forget one. The open app's heartbeat
--     (staff_presence) decides: their assistant rings them in the app, or the heads-up waits in their assistant chat
--     as unread. Their settings: ring or chat only, and quiet hours.

-- ─── Documents ───────────────────────────────────────────────────────────────

create table if not exists public.kaizen_documents (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.clients(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('sow', 'proposal', 'handoff', 'one_pager')),
  title       text not null,
  -- What the agent wrote (sections, tables, prices with where each came from): edited and drawn again from here
  content     jsonb not null default '{}',
  bucket      text not null default 'client-docs',
  path        text,
  file_name   text,
  version     integer not null default 1,
  pages       integer,
  -- Prices that weren't stored, drawn as a clearly marked placeholder
  placeholders text[] not null default '{}',
  client_document_id uuid references public.client_documents(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists kaizen_documents_client on public.kaizen_documents (client_id, created_at desc);
create index if not exists kaizen_documents_mine on public.kaizen_documents (profile_id, created_at desc);
alter table public.kaizen_documents enable row level security;
drop policy if exists "staff read documents" on public.kaizen_documents;
create policy "staff read documents" on public.kaizen_documents for select to authenticated
  using (profile_id = (select private.current_profile_id())
    or (client_id is not null and ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false))));

-- A generated document is one of the client's documents too
alter table public.client_documents drop constraint if exists client_documents_via_check;
alter table public.client_documents add constraint client_documents_via_check check (via in ('chat', 'page', 'portal', 'assistant'));

-- Package records can carry their price (a Scope of Work only shows a price that's stored)
alter table public.service_tiers add column if not exists price_monthly numeric;
alter table public.service_tiers add column if not exists price_one_time numeric;
alter table public.service_tiers add column if not exists price_note text;

-- Files on a client email draft (a Scope of Work PDF): [{ "document_id", "name", "bucket", "path", "mime" }]
alter table public.client_email_drafts add column if not exists attachments jsonb not null default '[]';

-- ─── Urgent heads-ups ───────────────────────────────────────────────────────

-- The open app says it's there (every few seconds while a tab is in view)
create table if not exists public.staff_presence (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  last_seen   timestamptz not null default now(),
  visible     boolean not null default true,
  in_call     boolean not null default false,
  path        text
);
alter table public.staff_presence enable row level security;
drop policy if exists "own presence" on public.staff_presence;
create policy "own presence" on public.staff_presence for select to authenticated using (profile_id = (select private.current_profile_id()));

-- Per person: ring (default) or chat only, and quiet hours in their time zone (no ring then; the chat still gets it)
create table if not exists public.assistant_ring_prefs (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  mode        text not null default 'ring' check (mode in ('ring', 'chat')),
  quiet_start time,
  quiet_end   time,
  tz          text not null default 'America/New_York',
  updated_at  timestamptz not null default now()
);
alter table public.assistant_ring_prefs enable row level security;
drop policy if exists "own ring prefs" on public.assistant_ring_prefs;
create policy "own ring prefs" on public.assistant_ring_prefs for all to authenticated
  using (profile_id = (select private.current_profile_id())) with check (profile_id = (select private.current_profile_id()));

-- One heads-up: rung (answered, declined or missed), or posted to their assistant chat as unread. Several urgent
-- items close together become one heads-up listing them.
create table if not exists public.assistant_heads_ups (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  items       jsonb not null default '[]',
  line        text not null,
  href        text,
  status      text not null default 'ringing' check (status in ('ringing', 'answered', 'chat')),
  outcome     text check (outcome in ('answered', 'declined', 'missed', 'not_active', 'in_call', 'quiet', 'chat_only', 'stale')),
  rang_at     timestamptz,
  ended_at    timestamptz,
  read_at     timestamptz,
  -- "Later": it stays at the top of their list until it's done
  later       boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists assistant_heads_ups_mine on public.assistant_heads_ups (profile_id, created_at desc);
create index if not exists assistant_heads_ups_unread on public.assistant_heads_ups (profile_id) where status = 'chat' and read_at is null;
alter table public.assistant_heads_ups enable row level security;
drop policy if exists "own heads ups" on public.assistant_heads_ups;
create policy "own heads ups" on public.assistant_heads_ups for select to authenticated using (profile_id = (select private.current_profile_id()));

-- The queue: each urgent thing once per person, until a heads-up takes it
create table if not exists public.assistant_heads_up_items (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  key         text not null,
  title       text not null,
  body        text,
  href        text,
  client_id   uuid references public.clients(id) on delete cascade,
  heads_up_id uuid references public.assistant_heads_ups(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (profile_id, key)
);
create index if not exists assistant_heads_up_items_pending on public.assistant_heads_up_items (profile_id, created_at) where heads_up_id is null;
alter table public.assistant_heads_up_items enable row level security;
drop policy if exists "own heads up items" on public.assistant_heads_up_items;
create policy "own heads up items" on public.assistant_heads_up_items for select to authenticated using (profile_id = (select private.current_profile_id()));

create or replace function private.queue_heads_up(p_profile uuid, p_key text, p_title text, p_body text, p_href text, p_client uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_profile is null or p_key is null then return; end if;
  -- Only people who use the app, and only while they're active
  if not exists (select 1 from public.profiles where id = p_profile and is_active) then return; end if;
  insert into public.assistant_heads_up_items (profile_id, key, title, body, href, client_id)
  values (p_profile, p_key, left(coalesce(p_title, 'Something urgent'), 300), left(p_body, 1000), p_href, p_client)
  on conflict (profile_id, key) do nothing;
end $$;
revoke execute on function private.queue_heads_up(uuid, text, text, text, text, uuid) from public, anon, authenticated;

-- A critical notification, or any client change of direction, queues a heads-up
create or replace function private.heads_up_from_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.read_at is null and (new.priority = 'critical' or new.kind = 'direction') then
    perform private.queue_heads_up(new.profile_id, 'n:' || new.key, new.title, new.body, new.href, new.client_id);
  end if;
  return new;
end $$;
drop trigger if exists heads_up_from_notification on public.notifications;
create trigger heads_up_from_notification after insert on public.notifications
  for each row execute function private.heads_up_from_notification();

-- An exec's ask that's due today (or already late) for someone else
create or replace function private.heads_up_from_ask()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_exec boolean; v_name text;
begin
  if new.owner_id = new.asked_by or new.due_on is null or new.status <> 'open' then return new; end if;
  if new.due_on > (now() at time zone 'America/New_York')::date then return new; end if;
  select is_exec, coalesce(nullif(display_name, ''), full_name) into v_exec, v_name from public.profiles where id = new.asked_by;
  if not coalesce(v_exec, false) then return new; end if;
  perform private.queue_heads_up(new.owner_id, 'ask:' || new.id, coalesce(split_part(v_name, ' ', 1), 'An exec') || ' needs this today: ' || new.title, nullif(new.detail, ''), '/pipeline#next', new.client_id);
  return new;
end $$;
drop trigger if exists heads_up_from_ask on public.agent_asks;
create trigger heads_up_from_ask after insert on public.agent_asks
  for each row execute function private.heads_up_from_ask();
