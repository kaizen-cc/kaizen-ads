-- Kaizen Ads — creative requests (tickets), their stages and their history.
-- Tickets move through ten stages. Each stage has a turnaround (business time, from `settings.sla`);
-- the board colors a ticket green while it's within turnaround, amber up to 12 business hours over,
-- red beyond that. All writes go through the checked functions below.

create type public.request_stage as enum (
  'requested', 'in_production', 'internal_review', 'copy', 'copy_review',
  'ready_for_client', 'client_review', 'client_revision', 'ready_for_launch', 'launched'
);
create type public.creative_format as enum ('image', 'video', 'carousel');
create type public.request_kind as enum ('new', 'iteration');
create type public.request_priority as enum ('normal', 'high', 'urgent');

create sequence public.request_number_seq start 1001;

create table public.requests (
  id               uuid primary key default gen_random_uuid(),
  number           int not null unique default nextval('public.request_number_seq'),
  client_id        uuid not null references public.clients(id) on delete cascade,
  title            text not null check (length(trim(title)) > 0),
  format           public.creative_format not null,
  kind             public.request_kind not null default 'new',
  priority         public.request_priority not null default 'normal',
  angle_id         uuid references public.angles(id) on delete set null,
  audience         text,
  brief            text,
  refs             text[] not null default '{}',     -- reference links (Motion, ads to iterate, examples)
  sizes            text[] not null default '{}',     -- 1x1, 4x5, 9x16
  quantity         int not null default 1 check (quantity between 1 and 100),
  stage            public.request_stage not null default 'requested',
  stage_entered_at timestamptz not null default now(),
  stage_due_at     timestamptz,                      -- turnaround for the current stage (editable)
  assignee_id      uuid references public.profiles(id) on delete set null,  -- who holds it right now
  creative_id      uuid references public.profiles(id) on delete set null,  -- designer / editor making it
  buyer_id         uuid references public.profiles(id) on delete set null,  -- media buyer for the client
  requested_by     uuid references public.profiles(id) on delete set null,
  launched_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on public.requests (client_id);
create index on public.requests (stage);
create index on public.requests (assignee_id);
create trigger requests_touch before update on public.requests for each row execute function public.touch_updated_at();

create table public.request_events (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests(id) on delete cascade,
  kind        text not null check (kind in ('created', 'stage', 'assign', 'due', 'priority', 'comment')),
  from_stage  public.request_stage,
  to_stage    public.request_stage,
  actor_id    uuid references public.profiles(id) on delete set null,
  body        text,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index on public.request_events (request_id, created_at);

alter table public.requests enable row level security;
alter table public.request_events enable row level security;

-- Team members see tickets for clients they can see. Clients never see raw tickets (the portal has its own views).
create policy "staff read requests" on public.requests for select to authenticated
  using (private.staff_can_see_client(client_id));
create policy "staff read request history" on public.request_events for select to authenticated
  using (exists (select 1 from public.requests r where r.id = request_id and private.staff_can_see_client(r.client_id)));

-- ─── Turnaround per stage ───────────────────────────────────────────────────
-- Production (requested + in production) runs from the request: images/carousels 2 days, videos 4.
-- Then: internal review 1 day · copy same day · copy review same day · ready for client 1 day ·
-- client follow-up 2 days · client revision 1 day · launch 1 day. Urgent halves it (minimum same day).
create function private.stage_due(
  p_stage public.request_stage, p_format public.creative_format, p_priority public.request_priority,
  p_entered timestamptz, p_created timestamptz
) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sla  jsonb := coalesce((select value from public.settings where key = 'sla'), '{}');
  v_base timestamptz := p_entered;
  v_days numeric;
begin
  case p_stage
    when 'requested', 'in_production' then
      v_base := p_created;
      v_days := coalesce((v_sla ->> ('production_' || p_format || '_days'))::numeric, 2);
    when 'internal_review'  then v_days := coalesce((v_sla ->> 'internal_review_days')::numeric, 1);
    when 'copy'             then v_days := 0;
    when 'copy_review'      then v_days := coalesce((v_sla ->> 'copy_review_days')::numeric, 0);
    when 'ready_for_client' then v_days := coalesce((v_sla ->> 'ready_for_client_days')::numeric, 1);
    when 'client_review'    then v_days := coalesce((v_sla ->> 'client_followup_days')::numeric, 2);
    when 'client_revision'  then v_days := coalesce((v_sla ->> 'client_revision_days')::numeric, 1);
    when 'ready_for_launch' then v_days := coalesce((v_sla ->> 'launch_days')::numeric, 1);
    else return null;  -- launched
  end case;

  if p_priority = 'urgent' then
    v_days := floor(v_days * coalesce((v_sla ->> 'urgent_multiplier')::numeric, 0.5));
  end if;

  if v_days <= 0 then
    return public.end_of_business_day(v_base);
  end if;
  return public.add_business_days(v_base, v_days::int);
end $$;

-- Who holds a ticket in each stage.
create function private.stage_owner(p_request public.requests, p_stage public.request_stage) returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    when p_stage in ('requested', 'in_production', 'client_revision') then p_request.creative_id
    when p_stage = 'internal_review' then
      (select id from public.profiles where role = 'head_of_creative' and is_active order by created_at limit 1)
    when p_stage = 'copy_review' then
      (select id from public.profiles where role = 'copywriter' and is_active order by created_at limit 1)
    when p_stage in ('ready_for_client', 'client_review') then
      (select id from public.profiles where role = 'customer_success' and is_active order by created_at limit 1)
    else p_request.buyer_id  -- copy, ready for launch, launched
  end
$$;

create function private.assert_can_work(p_request uuid) returns public.requests
language plpgsql stable security definer set search_path = '' as $$
declare r public.requests;
begin
  select * into r from public.requests where id = p_request;
  if r.id is null or not private.staff_can_see_client(r.client_id) then
    raise exception 'Ticket not found';
  end if;
  return r;
end $$;

-- ─── Create ─────────────────────────────────────────────────────────────────
create function public.create_request(
  p_client uuid, p_title text, p_format public.creative_format,
  p_kind public.request_kind default 'new', p_priority public.request_priority default 'normal',
  p_angle text default null, p_audience text default null, p_brief text default null,
  p_refs text[] default '{}', p_sizes text[] default '{}', p_quantity int default 1
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me       uuid := private.current_profile_id();
  v_creative uuid;
  v_buyer    uuid;
  v_angle    uuid;
  v_id       uuid;
  v_now      timestamptz := now();
begin
  if v_me is null or not private.staff_can_see_client(p_client) then
    raise exception 'You can only request creative for clients you work on';
  end if;

  select profile_id into v_creative from public.client_assignments
  where client_id = p_client and role = (case when p_format = 'video' then 'video_editor' else 'graphic_designer' end)::public.assignment_role
  limit 1;
  select profile_id into v_buyer from public.client_assignments
  where client_id = p_client and role = 'meta_buyer' limit 1;

  if nullif(trim(p_angle), '') is not null then
    insert into public.angles (client_id, name, source, created_by)
    values (p_client, trim(p_angle), 'request', v_me)
    on conflict (client_id, name) do update set status = 'active'
    returning id into v_angle;
  end if;

  insert into public.requests (
    client_id, title, format, kind, priority, angle_id, audience, brief, refs, sizes, quantity,
    stage, stage_entered_at, stage_due_at, assignee_id, creative_id, buyer_id, requested_by, created_at
  ) values (
    p_client, trim(p_title), p_format, p_kind, p_priority, v_angle, nullif(trim(p_audience), ''), nullif(trim(p_brief), ''),
    coalesce(p_refs, '{}'), coalesce(p_sizes, '{}'), greatest(coalesce(p_quantity, 1), 1),
    'requested', v_now, private.stage_due('requested', p_format, p_priority, v_now, v_now),
    v_creative, v_creative, v_buyer, v_me, v_now
  ) returning id into v_id;

  insert into public.request_events (request_id, kind, to_stage, actor_id)
  values (v_id, 'created', 'requested', v_me);
  return v_id;
end $$;

-- ─── Move to a stage ────────────────────────────────────────────────────────
create function public.move_request(p_request uuid, p_stage public.request_stage, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r     public.requests := private.assert_can_work(p_request);
  v_now timestamptz := now();
begin
  if r.stage = p_stage then return; end if;
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

-- ─── Reassign, due date, priority, comment ──────────────────────────────────
create function public.assign_request(p_request uuid, p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.requests := private.assert_can_work(p_request);
begin
  if p_profile is not null and not exists (select 1 from public.profiles where id = p_profile and is_active) then
    raise exception 'That person is not on the team';
  end if;
  update public.requests
  set assignee_id = p_profile,
      creative_id = case when r.stage in ('requested', 'in_production', 'client_revision') then p_profile else creative_id end
  where id = p_request;
  insert into public.request_events (request_id, kind, actor_id, data)
  values (p_request, 'assign', private.current_profile_id(), jsonb_build_object('from', r.assignee_id, 'to', p_profile));
end $$;

create function public.set_request_due(p_request uuid, p_due timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.requests := private.assert_can_work(p_request);
begin
  update public.requests set stage_due_at = p_due where id = p_request;
  insert into public.request_events (request_id, kind, actor_id, data)
  values (p_request, 'due', private.current_profile_id(), jsonb_build_object('from', r.stage_due_at, 'to', p_due));
end $$;

create function public.set_request_priority(p_request uuid, p_priority public.request_priority) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.requests := private.assert_can_work(p_request);
begin
  if r.priority = p_priority then return; end if;
  update public.requests set priority = p_priority where id = p_request;
  insert into public.request_events (request_id, kind, actor_id, data)
  values (p_request, 'priority', private.current_profile_id(), jsonb_build_object('from', r.priority, 'to', p_priority));
end $$;

create function public.comment_request(p_request uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.requests := private.assert_can_work(p_request);
begin
  if nullif(trim(p_body), '') is null then raise exception 'Write a comment first'; end if;
  insert into public.request_events (request_id, kind, actor_id, body)
  values (r.id, 'comment', private.current_profile_id(), trim(p_body));
end $$;

-- ─── Board view ─────────────────────────────────────────────────────────────
-- Time in stage and time over turnaround, both in business minutes (Mon–Fri 8am–6pm ET).
create view public.board_requests with (security_invoker = on) as
select r.*,
  c.name as client_name, c.slug as client_slug,
  a.full_name as assignee_name, cr.full_name as creative_name, b.full_name as buyer_name,
  an.name as angle_name,
  public.business_minutes_between(r.stage_entered_at, now()) as minutes_in_stage,
  case when r.stage_due_at is null then 0 else public.business_minutes_between(r.stage_due_at, now()) end as minutes_over
from public.requests r
join public.clients c on c.id = r.client_id
left join public.profiles a on a.id = r.assignee_id
left join public.profiles cr on cr.id = r.creative_id
left join public.profiles b on b.id = r.buyer_id
left join public.angles an on an.id = r.angle_id;

grant select on public.board_requests to authenticated;

revoke execute on function public.create_request(uuid, text, public.creative_format, public.request_kind, public.request_priority, text, text, text, text[], text[], int) from public, anon;
revoke execute on function public.move_request(uuid, public.request_stage, text) from public, anon;
revoke execute on function public.assign_request(uuid, uuid) from public, anon;
revoke execute on function public.set_request_due(uuid, timestamptz) from public, anon;
revoke execute on function public.set_request_priority(uuid, public.request_priority) from public, anon;
revoke execute on function public.comment_request(uuid, text) from public, anon;
grant execute on function public.create_request(uuid, text, public.creative_format, public.request_kind, public.request_priority, text, text, text, text[], text[], int) to authenticated;
grant execute on function public.move_request(uuid, public.request_stage, text) to authenticated;
grant execute on function public.assign_request(uuid, uuid) to authenticated;
grant execute on function public.set_request_due(uuid, timestamptz) to authenticated;
grant execute on function public.set_request_priority(uuid, public.request_priority) to authenticated;
grant execute on function public.comment_request(uuid, text) to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
