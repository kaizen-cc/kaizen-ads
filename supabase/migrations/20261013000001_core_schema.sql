-- Kaizen Ads — core schema (Phase 1: people, clients, contacts, assignments, angles, settings)
-- RLS grants reads; writes go through exec/lead policies or SECURITY DEFINER functions.

-- ─── Enums ──────────────────────────────────────────────────────────────────
create type public.client_status     as enum ('onboarding', 'active', 'paused', 'offboarded');
create type public.client_type       as enum ('traditional', 'whitelabel');
create type public.assignment_role   as enum ('meta_buyer', 'graphic_designer', 'video_editor', 'copywriter', 'coordinator');
create type public.angle_kind        as enum ('angle', 'avatar');
create type public.record_status     as enum ('active', 'archived');

-- ─── Shared trigger: keep updated_at current ────────────────────────────────
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ─── Team (Kaizen staff) ────────────────────────────────────────────────────
-- A profile exists before the person ever signs in: creating one IS the invite.
-- Role flags are additive (one person can be a buyer and a copywriter).
create table public.profiles (
  id               uuid primary key default gen_random_uuid(),
  auth_user_id     uuid unique references auth.users(id) on delete set null,
  email            text not null unique check (email = lower(email) and email like '%@kaizenmarketing.agency'),
  full_name        text not null,
  is_exec          boolean not null default false,
  is_lead          boolean not null default false,
  is_creative      boolean not null default false,
  is_buyer         boolean not null default false,
  is_copywriter    boolean not null default false,
  is_coordinator   boolean not null default false,
  is_active        boolean not null default true,
  avatar_url       text,
  track_profile_id uuid unique,          -- same person in Kaizen Track (for time sync later)
  joined_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- ─── Clients ────────────────────────────────────────────────────────────────
create table public.clients (
  id                    uuid primary key default gen_random_uuid(),
  kaizen_id             int unique,                    -- "ID" column in the Account Overview sheet
  track_client_id       uuid unique,                   -- same client in Kaizen Track
  name                  text not null,
  slug                  text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status                public.client_status not null default 'active',
  client_type           public.client_type not null default 'traditional',
  website               text,
  meta_ad_account_id    text,
  slack_channel_id      text,
  auto_approve_opt_in   boolean not null default false, -- client chose auto-approval after 48 business hours
  auto_approve_set_by   uuid,                           -- contact who opted in
  auto_approve_set_at   timestamptz,
  logo_path             text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger clients_touch before update on public.clients for each row execute function public.touch_updated_at();

create table public.client_assignments (
  client_id  uuid not null references public.clients(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role       public.assignment_role not null,
  created_at timestamptz not null default now(),
  primary key (client_id, role, profile_id)
);
create index on public.client_assignments (profile_id);

-- ─── Client contacts (log in by magic link) ─────────────────────────────────
create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users(id) on delete set null,
  email         text not null unique check (email = lower(email)),
  full_name     text,
  is_active     boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger contacts_touch before update on public.contacts for each row execute function public.touch_updated_at();

create table public.contact_clients (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  client_id  uuid not null references public.clients(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (contact_id, client_id)
);
create index on public.contact_clients (client_id);

-- ─── Angle / avatar library (copy is approved once per angle) ───────────────
create table public.angles (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  kind        public.angle_kind not null default 'angle',
  description text,
  status      public.record_status not null default 'active',
  source      text not null default 'manual',          -- manual | gtm_agent | request | import
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (client_id, name)
);
create trigger angles_touch before update on public.angles for each row execute function public.touch_updated_at();

-- ─── Monthly creative allotment (from the Creative KPI board) ───────────────
create table public.client_allotments (
  client_id         uuid primary key references public.clients(id) on delete cascade,
  images_per_month  int not null default 0 check (images_per_month >= 0),
  videos_per_month  int not null default 0 check (videos_per_month >= 0),
  updated_by        uuid references public.profiles(id),
  updated_at        timestamptz not null default now()
);

-- ─── Calendar & settings ────────────────────────────────────────────────────
create table public.holidays (
  day  date primary key,
  name text not null
);

create table public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

-- ─── App errors (same pattern as Kaizen Track) ──────────────────────────────
create table public.error_events (
  fingerprint   text primary key,
  message       text not null,
  path          text,
  kind          text not null,
  count         int not null default 1,
  people        text[] not null default '{}',
  sample        jsonb,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  last_alert_at timestamptz,
  resolved_at   timestamptz
);

-- Returns true when an alert email is due (first time, or hourly while it keeps happening).
create function public.record_error(
  p_fingerprint text, p_message text, p_path text, p_kind text, p_person text, p_sample jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_due boolean;
begin
  insert into public.error_events as e (fingerprint, message, path, kind, people, sample)
  values (p_fingerprint, p_message, p_path, p_kind, case when p_person is null then '{}' else array[p_person] end, p_sample)
  on conflict (fingerprint) do update
    set count = e.count + 1,
        last_seen = now(),
        resolved_at = null,
        sample = excluded.sample,
        people = case when p_person is null or p_person = any(e.people) then e.people
                      else (e.people || p_person)[1:20] end;

  update public.error_events
  set last_alert_at = now()
  where fingerprint = p_fingerprint
    and (last_alert_at is null or last_alert_at < now() - interval '1 hour')
  returning true into v_due;

  return coalesce(v_due, false);
end $$;
revoke execute on function public.record_error(text, text, text, text, text, jsonb) from public, anon, authenticated;

-- ─── Link a new sign-in to an invited profile or a known client contact ─────
-- Team: Google, @kaizenmarketing.agency, must already have a profile.
-- Clients: magic link, must already be a contact. Anyone else is rejected.
create function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(new.email);
  v_id    uuid;
begin
  if v_email like '%@kaizenmarketing.agency' then
    update public.profiles
    set auth_user_id = new.id,
        joined_at    = coalesce(joined_at, now()),
        avatar_url   = coalesce(avatar_url, new.raw_user_meta_data->>'avatar_url')
    where email = v_email and is_active
    returning id into v_id;
    if v_id is null then
      raise exception 'No invitation found for %', v_email;
    end if;
  else
    update public.contacts
    set auth_user_id = new.id
    where email = v_email and is_active
    returning id into v_id;
    if v_id is null then
      raise exception 'Not a client contact: %', v_email;
    end if;
  end if;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
