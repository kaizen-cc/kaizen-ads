-- Automatic launches: a ticket reaching Ready to launch is launched (paused) by Kaizen Ads, the buyer gets the links,
-- and when Meta shows the ad turned on the ticket completes itself. That last move is the system's, not a person's:
-- system_move_request does what move_request does without a signed-in person (service role only).
alter table public.launches add column if not exists auto boolean not null default false, add column if not exists live_at timestamptz;

create or replace function public.system_move_request(p_request uuid, p_stage public.request_stage, p_note text default null)
 returns void language plpgsql security definer set search_path to ''
as $function$
declare
  r public.requests;
  v_now timestamptz := now();
begin
  select * into r from public.requests where id = p_request;
  if not found or r.stage = p_stage then return; end if;
  update public.requests
  set stage = p_stage,
      stage_entered_at = v_now,
      stage_due_at = private.stage_due(p_stage, r.format, r.priority, v_now, r.created_at),
      assignee_id = coalesce(private.stage_owner(r, p_stage), r.assignee_id),
      launched_at = case when p_stage = 'launched' then v_now else null end
  where id = p_request;
  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, body)
  values (p_request, 'stage', r.stage, p_stage, null, nullif(trim(p_note), ''));
end $function$;
revoke all on function public.system_move_request(uuid, public.request_stage, text) from public, anon, authenticated;
grant execute on function public.system_move_request(uuid, public.request_stage, text) to service_role;
