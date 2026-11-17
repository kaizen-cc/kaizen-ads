-- The heads of Email and Organic Social read their team's unanswered messages (Nov 2026).
--
-- The daily recap and the Overview now cover the email and social lines. Each line's head gets what the other leads
-- get: their own unanswered messages, and the ones on their team that went past a second notice (the app shows them
-- only once escalated). Until now owed_replies was readable only by the person it waits on and by execs and leads
-- (profiles.is_lead, which is the heads of Meta, Creative and Google only), so the two new heads saw nothing of
-- their team's.
--
-- The rule is worked out once per query, never per row: the team's profile ids come from one (select ...) the policy
-- reuses for every row, like the client checks (20261117210000_fast_client_access.sql). The existing checks are
-- wrapped the same way.
--
-- Additive and idempotent: safe to run more than once. Nobody loses access; the two heads gain read access to their
-- own team's rows only. The app works before it's applied (the heads just see their own).

create or replace function private.my_line_team_ids()
returns uuid[]
language sql stable security definer set search_path to ''
as $$
  select coalesce(array(
    select p.id
      from public.profiles me
      join public.profiles p on p.is_active
     where me.auth_user_id = auth.uid() and me.is_active
       and ((me.role::text = 'head_of_email' and p.role::text in ('email_strategist', 'email_designer', 'email_builder'))
         or (me.role::text = 'head_of_social' and p.role::text = 'social_media_manager'))
  ), '{}')
$$;

revoke execute on function private.my_line_team_ids() from public, anon;
grant execute on function private.my_line_team_ids() to authenticated;

drop policy if exists "people read their own owed replies, leads and execs all" on public.owed_replies;
drop policy if exists "people read their own owed replies, their heads and execs" on public.owed_replies;
create policy "people read their own owed replies, their heads and execs" on public.owed_replies for select to authenticated
  using (
    target_id = (select private.current_profile_id())
    or (select private.is_exec_or_lead())
    or coalesce(target_id = any ((select private.my_line_team_ids())::uuid[]), false)
  );
