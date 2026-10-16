-- No new tickets for an archived client, however they'd be created (a leftover brief, a form, the API)
create function private.no_requests_for_archived() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.clients where id = new.client_id and archived_at is not null) then
    raise exception 'This client is archived. Restore them before requesting creative.';
  end if;
  return new;
end $$;
create trigger requests_not_for_archived before insert on public.requests
for each row execute function private.no_requests_for_archived();

-- An archived client's own page still shows their tickets (the board's view hides archived clients)
create view public.client_page_requests with (security_invoker = on) as
select r.id, r.number, r.client_id, r.title, r.format, r.kind, r.priority, r.angle_id, r.audience, r.brief, r.refs, r.sizes, r.quantity,
       r.stage, r.stage_entered_at, r.stage_due_at, r.assignee_id, r.creative_id, r.buyer_id, r.requested_by, r.launched_at,
       r.created_at, r.updated_at, r.batch_id, r.new_count, r.variation_count, r.ai_review, r.landing_url, r.parent_id,
       r.client_summary, r.deleted_at, r.deleted_by, r.delete_reason,
       c.name as client_name, c.slug as client_slug, a.full_name as assignee_name, cr.full_name as creative_name,
       b.full_name as buyer_name, an.name as angle_name, p.number as parent_number,
       (select count(*)::int from public.request_events e where e.request_id = r.id and e.kind = 'review' and (e.data ->> 'decision') = 'changes') as internal_rounds,
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
grant select on public.client_page_requests to authenticated;
