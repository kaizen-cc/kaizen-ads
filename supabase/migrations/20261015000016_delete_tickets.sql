-- Kaizen Ads — deleting tickets, reversibly
-- Execs and leads can delete a ticket (with a reason). It's a soft delete: the ticket disappears everywhere (the board,
-- the client page, the portal, the allotment) but stays in the database, listed in Settings → Deleted, where an exec
-- or lead can restore it exactly as it was.

alter table public.requests
  add column deleted_at     timestamptz,
  add column deleted_by     uuid references public.profiles(id) on delete set null,
  add column delete_reason  text;
create index on public.requests (deleted_at) where deleted_at is not null;

-- Deleted tickets are invisible to everyone's normal reads (the deleted log reads them through deleted_requests())
alter policy "staff read requests" on public.requests using (private.staff_can_see_client(client_id) and deleted_at is null);

-- ...and can't be worked on
create or replace function private.assert_can_work(p_request uuid) returns public.requests
language plpgsql stable security definer set search_path = '' as $$
declare r public.requests;
begin
  select * into r from public.requests where id = p_request;
  if r.id is null or r.deleted_at is not null or not private.staff_can_see_client(r.client_id) then
    raise exception 'Ticket not found';
  end if;
  return r;
end $$;

-- The board view leaves them out too (also for the server's own reads, which skip the access rules)
drop view public.board_requests;
create view public.board_requests with (security_invoker = on) as
select r.*,
  c.name as client_name, c.slug as client_slug,
  a.full_name as assignee_name, cr.full_name as creative_name, b.full_name as buyer_name,
  an.name as angle_name,
  p.number as parent_number,
  (select count(*)::int from public.request_events e where e.request_id = r.id and e.kind = 'review' and e.data->>'decision' = 'changes') as internal_rounds,
  (select count(*)::int from public.client_rounds cr2 where cr2.request_id = r.id and cr2.decision = 'revise') as client_rounds,
  public.business_minutes_between(r.stage_entered_at, now()) as minutes_in_stage,
  case when r.stage_due_at is null then 0 else public.business_minutes_between(r.stage_due_at, now()) end as minutes_over
from public.requests r
join public.clients c on c.id = r.client_id
left join public.profiles a on a.id = r.assignee_id
left join public.profiles cr on cr.id = r.creative_id
left join public.profiles b on b.id = r.buyer_id
left join public.angles an on an.id = r.angle_id
left join public.requests p on p.id = r.parent_id
where r.deleted_at is null;

-- A deleted ticket gives its creative back to the allotment
create or replace view public.client_allotment_usage with (security_invoker = on) as
with month as (
  select (date_trunc('month', (now() at time zone 'America/New_York')) at time zone 'America/New_York') as starts
)
select c.id as client_id,
  a.images_per_month,
  a.videos_per_month,
  coalesce(sum(r.new_count) filter (where r.format in ('image', 'carousel')), 0)::int as images_used,
  coalesce(sum(r.new_count) filter (where r.format = 'video'), 0)::int as videos_used,
  c.creative_package_until as package_until
from public.clients c
left join public.client_allotments a on a.client_id = c.id
left join public.requests r on r.client_id = c.id and r.created_at >= (select starts from month) and r.deleted_at is null
where c.creative_package and (c.creative_package_until is null or c.creative_package_until >= (now() at time zone 'America/New_York')::date)
group by c.id, a.images_per_month, a.videos_per_month, c.creative_package_until;

create function public.delete_request(p_request uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.requests := private.assert_can_work(p_request);
begin
  if not private.is_exec_or_lead() then raise exception 'Only execs and leads can delete a ticket'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Say why it''s being deleted'; end if;
  update public.requests set deleted_at = now(), deleted_by = private.current_profile_id(), delete_reason = trim(p_reason) where id = r.id;
  insert into public.request_events (request_id, kind, actor_id, body, data)
  values (r.id, 'stage', private.current_profile_id(), trim(p_reason), jsonb_build_object('action', 'deleted'));
end $$;

create function public.restore_request(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.requests;
begin
  if not private.is_exec_or_lead() then raise exception 'Only execs and leads can restore a ticket'; end if;
  select * into r from public.requests where id = p_request;
  if r.id is null or r.deleted_at is null or not private.staff_can_see_client(r.client_id) then raise exception 'Ticket not found'; end if;
  update public.requests set deleted_at = null, deleted_by = null, delete_reason = null where id = r.id;
  insert into public.request_events (request_id, kind, actor_id, data)
  values (r.id, 'stage', private.current_profile_id(), jsonb_build_object('action', 'restored', 'deleted_at', r.deleted_at));
end $$;

-- The deleted log, for execs and leads
create function public.deleted_requests() returns table (
  id uuid, number int, title text, client_name text, client_slug text, format text, stage text,
  new_count int, variation_count int, deleted_at timestamptz, deleted_by text, delete_reason text, created_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select r.id, r.number, r.title, c.name, c.slug, r.format::text, r.stage::text, r.new_count, r.variation_count,
         r.deleted_at, p.full_name, r.delete_reason, r.created_at
  from public.requests r
  join public.clients c on c.id = r.client_id
  left join public.profiles p on p.id = r.deleted_by
  where r.deleted_at is not null and private.is_exec_or_lead() and private.staff_can_see_client(r.client_id)
  order by r.deleted_at desc
  limit 500
$$;

revoke execute on function public.delete_request(uuid, text) from public, anon;
revoke execute on function public.restore_request(uuid) from public, anon;
revoke execute on function public.deleted_requests() from public, anon;
grant execute on function public.delete_request(uuid, text) to authenticated;
grant execute on function public.restore_request(uuid) to authenticated;
grant execute on function public.deleted_requests() to authenticated;
