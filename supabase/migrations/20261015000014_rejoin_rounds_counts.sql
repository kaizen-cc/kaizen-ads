-- Kaizen Ads — split tickets rejoin, revision rounds are counted, and the counts follow the work
--
-- 1. When a client approves part of a ticket, the approved part splits off to launch. Once both halves reach the same
--    stage again (Ready to launch or Launched), they rejoin into one ticket: designs, copy, comments, history, counts.
-- 2. Revision rounds: internal (the Head of Creative sent it back) and client (the client asked for changes), on the
--    board view.
-- 3. If more designs are uploaded than the ticket was for (a new variation or a net new design added along the way),
--    the ticket's counts go up to match, so the allotment counts what's really being made. Logged on the ticket.

-- ─── 1. Rejoin ──────────────────────────────────────────────────────────────
create function private.rejoin(p_keep uuid, p_absorb uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.requests;
  a public.requests;
  v_max int;
begin
  select * into k from public.requests where id = p_keep for update;
  select * into a from public.requests where id = p_absorb for update;
  if k.id is null or a.id is null or k.id = a.id then return; end if;

  -- Designs come home; a clashing D-number moves after the last one
  select coalesce(max(position), 0) into v_max from public.designs where request_id in (k.id, a.id);
  update public.designs d
  set request_id = k.id,
      position = case when exists (select 1 from public.designs x where x.request_id = k.id and x.position = d.position) then d.position + v_max else d.position end
  where d.request_id = a.id;
  update public.review_comments set request_id = k.id where request_id = a.id;
  update public.creative_ai_reviews set request_id = k.id where request_id = a.id;
  update public.request_events set request_id = k.id where request_id = a.id;
  select coalesce(max(round), 0) into v_max from public.client_rounds where request_id = k.id;
  update public.client_rounds set request_id = k.id, round = round + v_max where request_id = a.id;

  -- Copy: the original already holds every ad (the approved ones locked); a split's set is only a copy of those
  if exists (select 1 from public.copy_sets where request_id = k.id) then
    delete from public.copy_sets where request_id = a.id;
  else
    update public.copy_sets set request_id = k.id where request_id = a.id;
  end if;
  if exists (select 1 from public.copy_chats where request_id = k.id) then
    delete from public.copy_chats where request_id = a.id;
  else
    update public.copy_chats set request_id = k.id where request_id = a.id;
  end if;

  -- The counts the split took away come back (so the allotment counts each design once)
  update public.requests
  set new_count = k.new_count + a.new_count,
      variation_count = k.variation_count + a.variation_count,
      quantity = least(k.quantity + a.quantity, 100),
      title = case when k.parent_id is null then k.title else regexp_replace(k.title, ' · approved$', '') end,
      launched_at = least(k.launched_at, a.launched_at)
  where id = k.id;
  -- Anything that split off the absorbed ticket now belongs to the one that stays
  update public.requests set parent_id = k.id where parent_id = a.id;
  insert into public.request_events (request_id, kind, actor_id, data)
  values (k.id, 'upload', private.current_profile_id(), jsonb_build_object('action', 'rejoined', 'from', a.number));
  delete from public.requests where id = a.id;
end $$;

-- When a ticket reaches Ready to launch or Launched, any other part of the same ticket already there rejoins it.
-- The original (the one others split from) is the one that stays.
create function private.rejoin_on_stage() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r      public.requests;
  v_root uuid;
  v_keep uuid;
  v_other uuid;
begin
  -- Runs at the end of the transaction: look at the ticket as it is now (it may have moved again, or rejoined already)
  select * into r from public.requests where id = new.id;
  if r.id is null or r.stage not in ('ready_for_launch', 'launched') or new.stage is not distinct from old.stage then return null; end if;
  new := r;
  v_root := coalesce(r.parent_id, r.id);
  -- The parts of this ticket in the same stage: the original and anything split from it
  select id into v_keep from public.requests
  where (id = v_root or parent_id = v_root) and stage = new.stage
  order by (id = v_root) desc, created_at
  limit 1;
  for v_other in
    select id from public.requests
    where (id = v_root or parent_id = v_root) and stage = new.stage and id <> v_keep
  loop
    perform private.rejoin(v_keep, v_other);
  end loop;
  return null;
end $$;
-- Deferred to the end of the transaction, so whatever moved the ticket (and logged it) finishes first
create constraint trigger requests_rejoin after update of stage on public.requests
deferrable initially deferred
for each row execute function private.rejoin_on_stage();

-- ─── 3. Counts follow the uploads ───────────────────────────────────────────
create function private.counts_follow_designs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  v_new int;
  v_var int;
begin
  select * into r from public.requests where id = new.request_id for update;
  if r.id is null then return null; end if;
  select count(*) filter (where not is_variation), count(*) filter (where is_variation) into v_new, v_var
  from public.designs where request_id = r.id;
  if v_new > r.new_count or v_var > r.variation_count then
    update public.requests
    set new_count = greatest(r.new_count, v_new), variation_count = greatest(r.variation_count, v_var),
        quantity = least(greatest(r.new_count, v_new) + greatest(r.variation_count, v_var), 100)
    where id = r.id;
    insert into public.request_events (request_id, kind, actor_id, body, data)
    values (r.id, 'upload', private.current_profile_id(), 'More designs were added than the ticket was for, so its counts went up (net new counts toward the allotment).',
            jsonb_build_object('action', 'counts', 'auto', true, 'from_new', r.new_count, 'from_variations', r.variation_count,
                               'new', greatest(r.new_count, v_new), 'variations', greatest(r.variation_count, v_var)));
  end if;
  return null;
end $$;
-- After a design is added (not when it moves between parts of a split ticket, which keeps its own counts)
create trigger designs_counts after insert on public.designs
for each row execute function private.counts_follow_designs();

-- ─── 2. Rounds on the board ─────────────────────────────────────────────────
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
left join public.requests p on p.id = r.parent_id;

-- ─── The tickets already split and sitting in the same stage rejoin now ─────
do $$
declare x record;
begin
  for x in
    select c.parent_id as keep, c.id as absorb from public.requests c join public.requests p on p.id = c.parent_id
    where c.stage = p.stage and c.stage in ('ready_for_launch', 'launched')
  loop
    perform private.rejoin(x.keep, x.absorb);
  end loop;
end $$;
