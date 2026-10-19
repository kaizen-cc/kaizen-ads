-- Each person's notification settings, by group: in the app on or off, and email off / critical only / everything.
-- Missing means the defaults (in the app on, email for critical only, recap reminders and pop-ups on).
create table public.notification_prefs (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  settings   jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
create policy "own notification settings" on public.notification_prefs for all to authenticated
  using (profile_id = private.current_profile_id()) with check (profile_id = private.current_profile_id());

-- Which group a kind of notification belongs to
create function private.notice_group(p_kind text) returns text language sql immutable as $$
  select case
    when p_kind in ('assigned', 'handoff', 'client') then 'on_you'
    when p_kind = 'ticket' then 'work'
    when p_kind in ('promise', 'fatigue', 'kpi', 'sprint') then 'clients'
    when p_kind in ('onboarding', 'newclient') then 'leadership'
    when p_kind = 'recap' then 'recap'
    else 'work' end
$$;

-- The same as before, but it skips a group the person turned off in the app
create or replace function private.notify(p_profile uuid, p_kind text, p_title text, p_body text, p_href text, p_client uuid, p_key text, p_priority text default 'normal')
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.current_profile_id(); v_app text;
begin
  if p_profile is null or p_profile = v_actor then return; end if;
  if not exists (select 1 from public.profiles where id = p_profile and is_active and joined_at is not null) then return; end if;
  select settings->'groups'->private.notice_group(p_kind)->>'app' into v_app from public.notification_prefs where profile_id = p_profile;
  if v_app = 'false' then return; end if;
  insert into public.notifications (profile_id, kind, title, body, href, client_id, key, priority, actor_id)
  values (p_profile, p_kind, left(p_title, 300), left(p_body, 1000), p_href, p_client, p_key, p_priority, v_actor)
  on conflict (profile_id, key) do nothing;
end $$;

-- New clients get their own kind (the "client" kind is being put on a client)
create or replace function private.notify_new_client() returns trigger language plpgsql security definer set search_path = '' as $$
declare p uuid;
begin
  if new.status::text = 'onboarding' and (tg_op = 'INSERT' or old.status::text is distinct from 'onboarding') then
    for p in select * from private.managers() union select id from public.profiles where is_coordinator and is_active and joined_at is not null loop
      perform private.notify(p, 'newclient', format('New client: %s', new.name), 'Onboarding has started.', format('/clients/%s', new.slug), new.id, format('newclient:%s:%s', new.id, to_char(now(), 'YYYY-MM-DD')), 'normal');
    end loop;
  end if;
  return new;
end $$;
