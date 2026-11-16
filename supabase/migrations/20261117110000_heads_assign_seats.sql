-- The Head of Email and the Head of Organic Social assign their own team's seats (nothing else about assignments
-- changes). Until now only executives and leaders (is_exec_or_lead: the Heads of Meta, Creative and Google) could write
-- public.client_assignments, through "execs and leaders manage assignments" (for all). That stays exactly as is, and
-- profiles.is_lead is NOT touched (it also drives sees_all_clients, which these heads must not get).
--
--   old: insert / update / delete on client_assignments: executives and the Heads of Meta, Creative and Google only
--   new: additionally, the Head of Email may insert / update / delete the email seats (email_strategist, email_designer,
--        email_builder) and the Head of Organic Social the social seats (social_manager, social_creative), each only on a
--        client that buys that line's service (email-marketing / social-media, through private.client_services)
--
-- Policies are permissive, so these add to the existing rule instead of replacing it. Read access is unchanged.
-- Safe to run more than once; nothing is deleted or rewritten.

create or replace function private.head_may_assign(p_client uuid, p_role text)
returns boolean
language sql
stable security definer
set search_path to ''
as $$
  select exists (
    select 1
    from public.profiles me
    join public.clients c on c.id = p_client and c.archived_at is null
    where me.auth_user_id = auth.uid() and me.is_active
      and ((me.role::text = 'head_of_email'
            and p_role in ('email_strategist', 'email_designer', 'email_builder')
            and 'email-marketing' = any (private.client_services(c)))
        or (me.role::text = 'head_of_social'
            and p_role in ('social_manager', 'social_creative')
            and 'social-media' = any (private.client_services(c))))
  )
$$;
revoke all on function private.head_may_assign(uuid, text) from public, anon;
grant execute on function private.head_may_assign(uuid, text) to authenticated;

drop policy if exists "heads assign their seats insert" on public.client_assignments;
create policy "heads assign their seats insert" on public.client_assignments for insert to authenticated
  with check (private.head_may_assign(client_id, role::text));

drop policy if exists "heads assign their seats update" on public.client_assignments;
create policy "heads assign their seats update" on public.client_assignments for update to authenticated
  using (private.head_may_assign(client_id, role::text))
  with check (private.head_may_assign(client_id, role::text));

drop policy if exists "heads assign their seats delete" on public.client_assignments;
create policy "heads assign their seats delete" on public.client_assignments for delete to authenticated
  using (private.head_may_assign(client_id, role::text));
