-- Lead makers (lead graphic designer, lead video editor) see every client as an option: the client pickers, the board,
-- and requesting creative for any client. Everything else stays as their base role: they're still on the creative team
-- (is_creative), not leads (is_lead), and they don't get sees_all_clients(), which also gates managing client contacts.
-- So the widening is in can_see_client() alone, which the client reads (clients, assignments, requests, the board) and
-- the request creation checks (staff_can_see_client) go through.

-- On the creative team, like their base role
alter table public.profiles alter column is_creative set expression as (
  role = any (array['graphic_designer', 'video_editor', 'lead_graphic_designer', 'lead_video_editor', 'head_of_creative']::public.team_role[])
);

-- Whether the signed-in person is a lead maker
create or replace function private.is_lead_maker()
returns boolean
language sql
stable security definer
set search_path to ''
as $$
  select coalesce((
    select role in ('lead_graphic_designer', 'lead_video_editor')
    from public.profiles where auth_user_id = auth.uid() and is_active
  ), false)
$$;
revoke all on function private.is_lead_maker() from public;
grant execute on function private.is_lead_maker() to authenticated;

-- Which clients someone can see: everyone who sees all, the client's team, a lead maker (any client), or its contacts
create or replace function private.can_see_client(p_client uuid)
returns boolean
language sql
stable security definer
set search_path to ''
as $$
  select private.sees_all_clients()
    or private.is_lead_maker()
    or exists (select 1 from public.client_assignments
               where client_id = p_client and profile_id = private.current_profile_id())
    or exists (select 1 from public.contact_clients
               where client_id = p_client and contact_id = private.current_contact_id())
$$;

-- The two people in these positions today (approved by the owner)
update public.profiles set role = 'lead_graphic_designer' where id = '950a70cc-3855-44f9-b484-56139016e416';
update public.profiles set role = 'lead_video_editor' where id = 'dbe10509-96fb-4e3a-945f-993b4beb8eb1';
