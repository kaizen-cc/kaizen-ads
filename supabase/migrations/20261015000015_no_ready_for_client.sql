-- Kaizen Ads — no "Ready for client": approved work goes straight to the client's portal
--
-- With the AI review, creative review and copy review in front of it, nothing needs to wait for someone to send it.
-- Approving the creative goes on to whatever the copy still needs:
--   copy approved (a design-only revision) → With client
--   copy revised and waiting for copy review → Copy review
--   no copy yet, or the AI still writing it → Copy (the copywriter is assigned when the draft lands)
-- Approving the copy goes straight to With client. Customer success watches With client for what's stuck.

create or replace function public.review_creative(p_request uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r      public.requests := private.assert_can_work(p_request);
  v_me   uuid := private.current_profile_id();
  v_to   public.request_stage;
  v_now  timestamptz := now();
  v_open int;
  v_copy text;
begin
  if not private.is_exec_or_lead() then raise exception 'Only the head of creative or an exec can review creative'; end if;
  if r.stage <> 'internal_review' then raise exception 'This ticket isn''t waiting for creative review'; end if;
  if p_decision not in ('approve', 'changes') then raise exception 'Unknown decision'; end if;
  if not exists (select 1 from public.designs where request_id = p_request) then raise exception 'Nothing has been uploaded yet'; end if;
  select count(*) into v_open from public.review_comments where request_id = p_request and resolved_at is null and round = 'internal';
  if p_decision = 'changes' and v_open = 0 and nullif(trim(p_note), '') is null then
    raise exception 'Say what needs to change: pin a comment or add a note';
  end if;

  select status into v_copy from public.copy_sets where request_id = p_request;
  v_to := case
    when p_decision = 'changes' then 'in_production'
    when v_copy = 'approved' then 'client_review'
    when v_copy = 'review' then 'copy_review'
    else 'copy'
  end;
  update public.requests
  set stage = v_to,
      stage_entered_at = v_now,
      stage_due_at = private.stage_due(v_to, r.format, r.priority, v_now, r.created_at),
      assignee_id = case when v_to = 'copy' then null else coalesce(private.stage_owner(r, v_to), r.assignee_id) end
  where id = p_request;
  if p_decision = 'approve' then
    update public.review_comments set resolved_at = v_now, resolved_by = v_me
    where request_id = p_request and resolved_at is null and round = 'internal';
  end if;
  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, body, data)
  values (p_request, 'review', r.stage, v_to, v_me, nullif(trim(p_note), ''),
          jsonb_build_object('decision', p_decision, 'open_comments', v_open));
end $$;

create or replace function public.approve_copy(p_set uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s     public.copy_sets;
  r     public.requests;
  v_me  uuid := private.current_profile_id();
  v_now timestamptz := now();
  v_move boolean;
begin
  select * into s from public.copy_sets where id = p_set;
  if s.id is null then raise exception 'Copy not found'; end if;
  r := private.assert_can_work(s.request_id);
  if not (private.is_exec_or_lead() or exists (select 1 from public.profiles where id = v_me and role = 'copywriter')) then
    raise exception 'Only the copywriter or a lead can approve copy';
  end if;
  if jsonb_array_length(s.ads) = 0 then raise exception 'There''s no copy to approve'; end if;
  update public.copy_sets set status = 'approved', approved_by = v_me, approved_at = v_now, updated_at = v_now where id = p_set;
  -- From the copy stages straight to the client. (In client changes the design is still being reworked: it goes on
  -- after creative review, which sees the copy is approved.)
  v_move := r.stage in ('copy', 'copy_review', 'ready_for_client');
  if v_move then
    update public.requests
    set stage = 'client_review', stage_entered_at = v_now,
        stage_due_at = private.stage_due('client_review', r.format, r.priority, v_now, r.created_at),
        assignee_id = coalesce(private.stage_owner(r, 'client_review'), r.assignee_id)
    where id = r.id;
  end if;
  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, data)
  values (r.id, 'copy', r.stage, case when v_move then 'client_review'::public.request_stage else r.stage end, v_me,
          jsonb_build_object('action', case when s.reused_from is not null then 'reused' else 'approved' end));
end $$;

-- Anything left in the old column goes to the client
update public.requests
set stage = 'client_review', stage_entered_at = now(),
    stage_due_at = private.stage_due('client_review', format, priority, now(), created_at)
where stage = 'ready_for_client';
