-- Phone notices for urgent items (the owner approved phase 1, Nov 24 2026; docs/PHONE-NOTIFICATIONS.md): a critical
-- item nobody has seen for 10 minutes rings the phone of the teammate it's for, if they opted in. A short spoken notice:
-- press 1 for the details (and the link by text), 2 to snooze it an hour. Staff only, explicit opt-in per person,
-- quiet hours, rate limited. Dormant until TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are set.

-- Each person's own choice (written by them in Settings, through their own session)
create table if not exists public.phone_settings (
  profile_id    uuid primary key references public.profiles (id) on delete cascade,
  phone         text,
  opted_in      boolean not null default false,
  -- When they ticked the consent box (and the words they agreed to), kept as the record of their consent
  consent_at    timestamptz,
  consent_text  text,
  quiet_start   smallint not null default 21 check (quiet_start between 0 and 23),
  quiet_end     smallint not null default 7 check (quiet_end between 0 and 23),
  timezone      text not null default 'America/New_York',
  updated_at    timestamptz not null default now()
);
alter table public.phone_settings enable row level security;
create policy "own phone settings read" on public.phone_settings for select to authenticated using (profile_id = (select private.current_profile_id()));
create policy "own phone settings insert" on public.phone_settings for insert to authenticated with check (profile_id = (select private.current_profile_id()));
create policy "own phone settings update" on public.phone_settings for update to authenticated using (profile_id = (select private.current_profile_id())) with check (profile_id = (select private.current_profile_id()));

-- Every call placed (a notice for an item, or a test call), written by the server from Twilio's callbacks
create table if not exists public.phone_calls (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.profiles (id) on delete cascade,
  notification_id  uuid references public.notifications (id) on delete set null,
  kind             text not null check (kind in ('notice', 'test')),
  title            text not null,
  status           text not null default 'queued',
  twilio_sid       text,
  digits           text,
  snoozed_until    timestamptz,
  texted_at        timestamptz,
  duration_seconds integer,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists phone_calls_person on public.phone_calls (profile_id, created_at desc);
create index if not exists phone_calls_item on public.phone_calls (notification_id);
alter table public.phone_calls enable row level security;
create policy "own phone calls" on public.phone_calls for select to authenticated using (profile_id = (select private.current_profile_id()));
