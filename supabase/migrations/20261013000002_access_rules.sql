-- Kaizen Ads — who can see what (RLS)
-- Helpers live in `private` (not exposed through the API), SECURITY DEFINER with an empty search_path.
--
-- Team:     execs, leads, the coordinator (Jorgi) and the copywriter (Camille) see every client.
--           Everyone else sees the clients they're assigned to.
-- Contacts: see only the clients they're linked to, and never team-only tables.

create schema if not exists private;
grant usage on schema private to authenticated;

create function private.current_profile_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.profiles where auth_user_id = auth.uid() and is_active
$$;

create function private.current_contact_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.contacts where auth_user_id = auth.uid() and is_active
$$;

create function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.current_profile_id() is not null
$$;

create function private.is_exec() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_exec from public.profiles where auth_user_id = auth.uid() and is_active), false)
$$;

-- Execs and leads: approve upgrades, edit AI instructions, review creative
create function private.is_exec_or_lead() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_exec or is_lead from public.profiles where auth_user_id = auth.uid() and is_active), false)
$$;

-- Staff who work across every client
create function private.sees_all_clients() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select is_exec or is_lead or is_coordinator or is_copywriter
    from public.profiles where auth_user_id = auth.uid() and is_active
  ), false)
$$;

create function private.can_see_client(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.sees_all_clients()
    or exists (select 1 from public.client_assignments
               where client_id = p_client and profile_id = private.current_profile_id())
    or exists (select 1 from public.contact_clients
               where client_id = p_client and contact_id = private.current_contact_id())
$$;

create function private.staff_can_see_client(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_staff() and private.can_see_client(p_client)
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- ─── Enable RLS everywhere ──────────────────────────────────────────────────
alter table public.profiles           enable row level security;
alter table public.clients            enable row level security;
alter table public.client_assignments enable row level security;
alter table public.contacts           enable row level security;
alter table public.contact_clients    enable row level security;
alter table public.angles             enable row level security;
alter table public.client_allotments  enable row level security;
alter table public.holidays           enable row level security;
alter table public.settings           enable row level security;
alter table public.error_events       enable row level security;

-- ─── profiles ───────────────────────────────────────────────────────────────
create policy "staff read team" on public.profiles for select to authenticated
  using (private.is_staff());
create policy "execs manage team" on public.profiles for all to authenticated
  using (private.is_exec()) with check (private.is_exec());

-- ─── clients ────────────────────────────────────────────────────────────────
create policy "see own clients" on public.clients for select to authenticated
  using (private.can_see_client(id));
create policy "execs manage clients" on public.clients for all to authenticated
  using (private.is_exec()) with check (private.is_exec());

-- ─── client_assignments ─────────────────────────────────────────────────────
create policy "staff read assignments" on public.client_assignments for select to authenticated
  using (private.staff_can_see_client(client_id));
create policy "execs manage assignments" on public.client_assignments for all to authenticated
  using (private.is_exec()) with check (private.is_exec());

-- ─── contacts ───────────────────────────────────────────────────────────────
create policy "contact reads self" on public.contacts for select to authenticated
  using (id = private.current_contact_id());
create policy "staff read client contacts" on public.contacts for select to authenticated
  using (private.is_staff() and (
    private.sees_all_clients()
    or exists (select 1 from public.contact_clients cc
               where cc.contact_id = contacts.id and private.can_see_client(cc.client_id))
  ));
create policy "leads manage contacts" on public.contacts for all to authenticated
  using (private.is_exec_or_lead() or private.sees_all_clients())
  with check (private.is_exec_or_lead() or private.sees_all_clients());

-- ─── contact_clients ────────────────────────────────────────────────────────
create policy "contact reads own brands" on public.contact_clients for select to authenticated
  using (contact_id = private.current_contact_id());
create policy "staff read brand access" on public.contact_clients for select to authenticated
  using (private.staff_can_see_client(client_id));
create policy "leads manage brand access" on public.contact_clients for all to authenticated
  using (private.sees_all_clients()) with check (private.sees_all_clients());

-- ─── angles ─────────────────────────────────────────────────────────────────
create policy "read angles" on public.angles for select to authenticated
  using (private.can_see_client(client_id));
create policy "staff add angles" on public.angles for insert to authenticated
  with check (private.staff_can_see_client(client_id));
create policy "staff edit angles" on public.angles for update to authenticated
  using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));

-- ─── client_allotments ──────────────────────────────────────────────────────
create policy "read allotment" on public.client_allotments for select to authenticated
  using (private.can_see_client(client_id));
create policy "execs leads set allotment" on public.client_allotments for all to authenticated
  using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());

-- ─── holidays & settings ────────────────────────────────────────────────────
create policy "anyone signed in reads holidays" on public.holidays for select to authenticated using (true);
create policy "execs manage holidays" on public.holidays for all to authenticated
  using (private.is_exec()) with check (private.is_exec());
create policy "staff read settings" on public.settings for select to authenticated using (private.is_staff());
create policy "execs manage settings" on public.settings for all to authenticated
  using (private.is_exec()) with check (private.is_exec());

-- ─── error_events ───────────────────────────────────────────────────────────
create policy "execs read errors" on public.error_events for select to authenticated using (private.is_exec());
create policy "execs resolve errors" on public.error_events for update to authenticated
  using (private.is_exec()) with check (private.is_exec());
