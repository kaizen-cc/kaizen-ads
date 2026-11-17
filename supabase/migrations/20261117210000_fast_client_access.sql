-- Faster client access checks (Nov 2026).
--
-- Almost every table's policy asked private.staff_can_see_client(client_id) or private.can_see_client(client_id) for
-- each row, and each call ran half a dozen lookups of the person's profile, assignments and contacts: about 1.4 ms a
-- row, so a page reading a few thousand rows waited seconds (the Clients list spent 4.4 s on its Meta snapshots alone).
--
-- The same rule is now worked out once per query: who sees every client (a yes or no), and the list of clients someone
-- else sees. Each policy reads both through a (select ...), which Postgres runs once and reuses for every row. Who sees
-- what is unchanged: the functions below are the same rule as private.can_see_client, which stays for code that calls
-- it with one client.
--
-- New policies: write ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false))
-- instead of private.staff_can_see_client(client_id).

-- Sees every client: execs, leads, the coordinator, the copywriter and the lead makers
create or replace function private.sees_all_or_lead()
returns boolean
language sql stable security definer set search_path to ''
as $$
  select private.sees_all_clients() or private.is_lead_maker()
$$;

create or replace function private.staff_sees_all()
returns boolean
language sql stable security definer set search_path to ''
as $$
  select private.is_staff() and private.sees_all_or_lead()
$$;

-- The clients someone sees without seeing them all: their assignments, the email or social head's clients on that
-- service (not archived), and a contact's own brands (not taken off)
create or replace function private.my_client_ids()
returns uuid[]
language sql stable security definer set search_path to ''
as $$
  select coalesce(array(
    select client_id from public.client_assignments where profile_id = private.current_profile_id()
    union
    select c.id from public.profiles me join public.clients c on c.archived_at is null
     where me.auth_user_id = auth.uid() and me.is_active
       and ((me.role::text = 'head_of_email' and 'email-marketing' = any (private.client_services(c)))
         or (me.role::text = 'head_of_social' and 'social-media' = any (private.client_services(c))))
    union
    select client_id from public.contact_clients where contact_id = private.current_contact_id() and removed_at is null
  ), '{}')
$$;

create or replace function private.staff_client_ids()
returns uuid[]
language sql stable security definer set search_path to ''
as $$
  select case when private.is_staff() then private.my_client_ids() else '{}'::uuid[] end
$$;

revoke execute on function private.sees_all_or_lead(), private.staff_sees_all(), private.my_client_ids(), private.staff_client_ids() from public, anon;
grant execute on function private.sees_all_or_lead(), private.staff_sees_all(), private.my_client_ids(), private.staff_client_ids() to authenticated;

-- Every policy calling the per-row checks, rewritten to the once-per-query form (the argument kept as written, so
-- private.path_client(name) on storage works the same)
do $$
declare
  p record;
  arg constant text := '((?:[^()]|\([^()]*\))*)';
  q text;
  c text;
  sql text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname in ('public', 'storage')
       and coalesce(qual, '') || coalesce(with_check, '') ~ 'private\.(staff_)?can_see_client\('
  loop
    q := p.qual;
    c := p.with_check;
    q := regexp_replace(q, 'private\.staff_can_see_client\(' || arg || '\)', '((SELECT private.staff_sees_all()) OR COALESCE((\1) = ANY ((SELECT private.staff_client_ids())::uuid[]), false))', 'g');
    q := regexp_replace(q, 'private\.can_see_client\(' || arg || '\)', '((SELECT private.sees_all_or_lead()) OR COALESCE((\1) = ANY ((SELECT private.my_client_ids())::uuid[]), false))', 'g');
    c := regexp_replace(c, 'private\.staff_can_see_client\(' || arg || '\)', '((SELECT private.staff_sees_all()) OR COALESCE((\1) = ANY ((SELECT private.staff_client_ids())::uuid[]), false))', 'g');
    c := regexp_replace(c, 'private\.can_see_client\(' || arg || '\)', '((SELECT private.sees_all_or_lead()) OR COALESCE((\1) = ANY ((SELECT private.my_client_ids())::uuid[]), false))', 'g');
    sql := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if q is not null then sql := sql || ' using (' || q || ')'; end if;
    if c is not null then sql := sql || ' with check (' || c || ')'; end if;
    begin
      execute sql;
    exception when insufficient_privilege then
      raise notice 'left as it was (not ours to change): %.% %', p.schemaname, p.tablename, p.policyname;
    end;
  end loop;
end $$;

-- The Clients list reads the newest Meta snapshots across every client
create index if not exists meta_snapshots_fetched_at_idx on public.meta_snapshots (fetched_at desc);
