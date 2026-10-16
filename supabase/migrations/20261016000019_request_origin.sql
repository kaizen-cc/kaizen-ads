-- What a ticket was built on (a winning ad, a market ad, a promise from a call, an AI brief), so the creative team
-- sees the idea behind it: { kind, label, link, thumb }
alter table public.requests add column if not exists origin jsonb;

create or replace view public.board_requests with (security_invoker = on) as
select r.id, r.number, r.client_id, r.title, r.format, r.kind, r.priority, r.angle_id, r.audience, r.brief, r.refs, r.sizes, r.quantity,
       r.stage, r.stage_entered_at, r.stage_due_at, r.assignee_id, r.creative_id, r.buyer_id, r.requested_by, r.launched_at,
       r.created_at, r.updated_at, r.batch_id, r.new_count, r.variation_count, r.ai_review, r.landing_url, r.parent_id,
       r.client_summary, r.deleted_at, r.deleted_by, r.delete_reason,
       c.name as client_name, c.slug as client_slug, a.full_name as assignee_name, cr.full_name as creative_name,
       b.full_name as buyer_name, an.name as angle_name, p.number as parent_number,
       (select count(*)::int from public.request_events e where e.request_id = r.id and e.kind = 'review' and (e.data ->> 'decision') = 'changes') as internal_rounds,
       (select count(*)::int from public.client_rounds cr2 where cr2.request_id = r.id and cr2.decision = 'revise') as client_rounds,
       public.business_minutes_between(r.stage_entered_at, now()) as minutes_in_stage,
       case when r.stage_due_at is null then 0 else public.business_minutes_between(r.stage_due_at, now()) end as minutes_over,
       r.origin
from public.requests r
join public.clients c on c.id = r.client_id
left join public.profiles a on a.id = r.assignee_id
left join public.profiles cr on cr.id = r.creative_id
left join public.profiles b on b.id = r.buyer_id
left join public.angles an on an.id = r.angle_id
left join public.requests p on p.id = r.parent_id
where r.deleted_at is null and c.archived_at is null;

create or replace view public.client_page_requests with (security_invoker = on) as
select r.id, r.number, r.client_id, r.title, r.format, r.kind, r.priority, r.angle_id, r.audience, r.brief, r.refs, r.sizes, r.quantity,
       r.stage, r.stage_entered_at, r.stage_due_at, r.assignee_id, r.creative_id, r.buyer_id, r.requested_by, r.launched_at,
       r.created_at, r.updated_at, r.batch_id, r.new_count, r.variation_count, r.ai_review, r.landing_url, r.parent_id,
       r.client_summary, r.deleted_at, r.deleted_by, r.delete_reason,
       c.name as client_name, c.slug as client_slug, a.full_name as assignee_name, cr.full_name as creative_name,
       b.full_name as buyer_name, an.name as angle_name, p.number as parent_number,
       (select count(*)::int from public.request_events e where e.request_id = r.id and e.kind = 'review' and (e.data ->> 'decision') = 'changes') as internal_rounds,
       (select count(*)::int from public.client_rounds cr2 where cr2.request_id = r.id and cr2.decision = 'revise') as client_rounds,
       public.business_minutes_between(r.stage_entered_at, now()) as minutes_in_stage,
       case when r.stage_due_at is null then 0 else public.business_minutes_between(r.stage_due_at, now()) end as minutes_over,
       r.origin
from public.requests r
join public.clients c on c.id = r.client_id
left join public.profiles a on a.id = r.assignee_id
left join public.profiles cr on cr.id = r.creative_id
left join public.profiles b on b.id = r.buyer_id
left join public.angles an on an.id = r.angle_id
left join public.requests p on p.id = r.parent_id
where r.deleted_at is null;
