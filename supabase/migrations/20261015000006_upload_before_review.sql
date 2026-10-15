-- Kaizen Ads — nothing moves past production without a creative
-- A ticket can only go to creative review (or any later stage) once at least one file is uploaded to it.
-- Moving back (to Requested or In production) is always allowed. Applies to the drawer, the Move to menu and
-- dragging on the board, since they all go through move_request.

create function private.has_creative(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.design_files f
    join public.designs d on d.id = f.design_id
    where d.request_id = p_request
  )
$$;
revoke execute on function private.has_creative(uuid) from public, anon;
grant execute on function private.has_creative(uuid) to authenticated;

create or replace function public.move_request(p_request uuid, p_stage public.request_stage, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r     public.requests := private.assert_can_work(p_request);
  v_now timestamptz := now();
begin
  if r.stage = p_stage then return; end if;
  if p_stage not in ('requested', 'in_production') and not private.has_creative(p_request) then
    raise exception 'Upload the creative first. A ticket can''t move past production without it.';
  end if;
  update public.requests
  set stage = p_stage,
      stage_entered_at = v_now,
      stage_due_at = private.stage_due(p_stage, r.format, r.priority, v_now, r.created_at),
      assignee_id = coalesce(private.stage_owner(r, p_stage), r.assignee_id),
      launched_at = case when p_stage = 'launched' then v_now else null end
  where id = p_request;
  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, body)
  values (p_request, 'stage', r.stage, p_stage, private.current_profile_id(), nullif(trim(p_note), ''));
end $$;
