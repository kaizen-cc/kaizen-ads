-- View as: the owner switches the app to exactly what one teammate (or one role) sees, to train people and debug
-- "it looks different on my screen". Read only while it's on.
--
-- How the data stays exact (RLS):
--   * The app's server sends `x-kz-view-as: <profile id>` on every Supabase request while the owner is viewing as
--     someone (the session client and the admin client both carry it).
--   * PostgREST runs public.kz_view_as_pre_request() before each request. When the header is there it makes the whole
--     request's transaction READ ONLY (nothing can be written, by any role, through any table or RPC), and, when the
--     signed-in person is allowed to view as (profiles.can_view_as) and the target is an active teammate, it sets
--     kz.view_as for the transaction.
--   * private.current_profile_id() answers kz.view_as when it's set, and every RLS helper that used to read
--     auth.uid() itself now goes through private.current_profile_id(): every policy then answers as the target, with
--     the target's own client access, roles and gates.
--   * The flag is only ever set here, for the owner; a trigger keeps anyone signed in (other execs included) from
--     switching it on.

alter table public.profiles add column if not exists can_view_as boolean not null default false;

update public.profiles set can_view_as = true where lower(email) = 'santi@kaizenmarketing.agency';

create or replace function private.guard_can_view_as() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Only a migration (or the server's own key) changes who can view as; a signed-in person never can, execs included
  if new.can_view_as is distinct from old.can_view_as and coalesce(auth.role(), '') in ('authenticated', 'anon') then
    raise exception 'can_view_as is set by Kaizen only';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_can_view_as on public.profiles;
create trigger profiles_guard_can_view_as before update of can_view_as on public.profiles
  for each row execute function private.guard_can_view_as();

-- The audit: each start and stop (who, as whom, when)
create table if not exists public.view_as_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  -- 'person': a chosen teammate; 'role': a role, shown through a representative active teammate in it
  mode text not null check (mode in ('person', 'role')),
  role text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists view_as_log_actor_idx on public.view_as_log (actor_id, started_at desc);
alter table public.view_as_log enable row level security;
drop policy if exists "execs read view as log" on public.view_as_log;
create policy "execs read view as log" on public.view_as_log for select to authenticated using ((select private.is_exec()));

-- Who the app is answering as: the viewed-as teammate during view as, otherwise the signed-in person
create or replace function private.current_profile_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    nullif(current_setting('kz.view_as', true), '')::uuid,
    (select id from public.profiles where auth_user_id = auth.uid() and is_active)
  )
$$;

-- Runs before every PostgREST request (pgrst.db_pre_request), for every role (anon has no use of the private schema,
-- so it lives in public; calling it on its own changes nothing but that one request). Never fails a request.
create or replace function public.kz_view_as_pre_request() returns void
language plpgsql security definer set search_path = '' as $$
declare
  h text;
  target uuid;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json ->> 'x-kz-view-as';
  exception when others then
    h := null;
  end;
  if h is null or h = '' then
    return;
  end if;
  if h ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    begin
      select t.id into target
        from public.profiles me
        join public.profiles t on t.id = h::uuid and t.is_active
       where me.auth_user_id = auth.uid() and me.is_active and me.can_view_as;
    exception when others then
      target := null;
    end;
    if target is not null then
      perform set_config('kz.view_as', target::text, true);
    end if;
  end if;
  -- Any request that says "view as" is read only, whoever sends it (set last, outside any sub-block, so it holds)
  perform set_config('transaction_read_only', 'on', true);
end $$;

grant execute on function public.kz_view_as_pre_request() to anon, authenticated, service_role;

-- The helpers that read auth.uid() themselves now answer through private.current_profile_id()
create or replace function private.can_edit_bible(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select p.is_exec or p.is_lead or exists (
      select 1 from public.client_assignments a where a.client_id = p_client and a.profile_id = p.id and a.role = 'coordinator')
    from public.profiles p where p.id = private.current_profile_id()), false)
$$;

create or replace function private.can_see_client(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.sees_all_clients()
    or private.is_lead_maker()
    or exists (select 1 from public.client_assignments where client_id = p_client and profile_id = private.current_profile_id())
    or exists (select 1 from public.profiles me join public.clients c on c.id = p_client and c.archived_at is null
               where me.id = private.current_profile_id()
                 and ((me.role::text = 'head_of_email' and 'email-marketing' = any (private.client_services(c)))
                   or (me.role::text = 'head_of_social' and 'social-media' = any (private.client_services(c)))))
    or exists (select 1 from public.contact_clients where client_id = p_client and contact_id = private.current_contact_id() and removed_at is null)
$$;

create or replace function private.head_may_assign(p_client uuid, p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.profiles me
    join public.clients c on c.id = p_client and c.archived_at is null
    where me.id = private.current_profile_id()
      and ((me.role::text = 'head_of_email'
            and p_role in ('email_strategist', 'email_designer', 'email_builder')
            and 'email-marketing' = any (private.client_services(c)))
        or (me.role::text = 'head_of_social'
            and p_role in ('social_manager', 'social_creative')
            and 'social-media' = any (private.client_services(c))))
  )
$$;

create or replace function private.is_brief_approver() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_exec or role in ('head_of_creative', 'head_of_meta', 'lead_graphic_designer', 'lead_video_editor') from public.profiles where id = private.current_profile_id()), false)
$$;

create or replace function private.is_exec() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_exec from public.profiles where id = private.current_profile_id()), false)
$$;

create or replace function private.is_exec_or_lead() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_exec or is_lead from public.profiles where id = private.current_profile_id()), false)
$$;

create or replace function private.is_lead_maker() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select role in ('lead_graphic_designer', 'lead_video_editor')
    from public.profiles where id = private.current_profile_id()
  ), false)
$$;

create or replace function private.my_client_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array(
    select client_id from public.client_assignments where profile_id = private.current_profile_id()
    union
    select c.id from public.profiles me join public.clients c on c.archived_at is null
     where me.id = private.current_profile_id()
       and ((me.role::text = 'head_of_email' and 'email-marketing' = any (private.client_services(c)))
         or (me.role::text = 'head_of_social' and 'social-media' = any (private.client_services(c))))
    union
    select client_id from public.contact_clients where contact_id = private.current_contact_id() and removed_at is null
  ), '{}')
$$;

create or replace function private.my_line_team_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array(
    select p.id
      from public.profiles me
      join public.profiles p on p.is_active
     where me.id = private.current_profile_id()
       and ((me.role::text = 'head_of_email' and p.role::text in ('email_strategist', 'email_designer', 'email_builder'))
         or (me.role::text = 'head_of_social' and p.role::text = 'social_media_manager'))
  ), '{}')
$$;

create or replace function private.sees_all_clients() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select is_exec or is_lead or is_coordinator or is_copywriter
    from public.profiles where id = private.current_profile_id()
  ), false)
$$;

create or replace function private.sees_paid_ads() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select role::text not in ('head_of_social', 'social_media_manager', 'head_of_email', 'email_strategist', 'email_designer', 'email_builder')
    from public.profiles where id = private.current_profile_id()
  ), true)
$$;

-- PostgREST calls the pre-request function on every request
alter role authenticator set pgrst.db_pre_request = 'public.kz_view_as_pre_request';
notify pgrst, 'reload config';
