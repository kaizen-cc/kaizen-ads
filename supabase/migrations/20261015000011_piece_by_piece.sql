-- Kaizen Ads — clients approve piece by piece; approved pieces launch while the rest is reworked
--
-- In the portal a client first reads why we made the ads (who they're for, the strategy), then approves or asks for
-- changes on each design and each copy ad, one at a time. Approved pieces are locked. When some pieces are approved and
-- others need changes, the approved designs and copy split off into their own ticket in Ready to launch (linked to the
-- original) so they can run while the rest is reworked; only the changed pieces go back to the client.
-- Also: the landing page, set on the request, shown in copy and in every preview.

alter table public.requests
  add column landing_url     text check (landing_url is null or landing_url ~* '^https?://'),
  add column parent_id       uuid references public.requests(id) on delete set null,  -- split off from this ticket
  add column client_summary  jsonb;  -- {why, audience, strategy}: what the client reads before reviewing

alter table public.designs
  add column client_status      text check (client_status in ('approved', 'changes')),
  add column client_version     int,           -- the version the client decided on
  add column client_decided_at  timestamptz;

-- Per ad, in order: [{status: 'approved' | 'changes' | null, note}]
alter table public.copy_sets add column client_status jsonb not null default '[]';

-- The board view picks up the new columns, and the number of the ticket a split came from
drop view public.board_requests;
create view public.board_requests with (security_invoker = on) as
select r.*,
  c.name as client_name, c.slug as client_slug,
  a.full_name as assignee_name, cr.full_name as creative_name, b.full_name as buyer_name,
  an.name as angle_name,
  p.number as parent_number,
  public.business_minutes_between(r.stage_entered_at, now()) as minutes_in_stage,
  case when r.stage_due_at is null then 0 else public.business_minutes_between(r.stage_due_at, now()) end as minutes_over
from public.requests r
join public.clients c on c.id = r.client_id
left join public.profiles a on a.id = r.assignee_id
left join public.profiles cr on cr.id = r.creative_id
left join public.profiles b on b.id = r.buyer_id
left join public.angles an on an.id = r.angle_id
left join public.requests p on p.id = r.parent_id;

-- ─── The client's review, piece by piece. Called by the server after it checks who's deciding. ──
-- p_designs: [{design_id, decision: 'approved' | 'changes', note}]   (pins are stored by the server as comments)
-- p_ads:     [{index, decision, note}]                              (index into the copy set, from 0)
-- Every piece still waiting on the client must be decided. Returns {round, stage, split_id, split_number}.
create function public.client_submit_review(p_request uuid, p_designs jsonb, p_ads jsonb, p_by_contact uuid, p_by_profile uuid, p_by_name text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r          public.requests;
  s          public.copy_sets;
  v_now      timestamptz := now();
  v_round    int;
  v_status   jsonb;
  v_i        int;
  v_d        jsonb;
  v_ok_d     int; v_ch_d int; v_ok_a int; v_ch_a int;
  v_new      int; v_var int;
  v_split    uuid;
  v_split_no int;
  v_to       public.request_stage;
  v_dnotes   text;
  v_anotes   text;
  v_targets  text[] := '{}';
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Ticket not found'; end if;
  if r.stage <> 'client_review' then raise exception 'This ad isn''t waiting for your review any more'; end if;
  select * into s from public.copy_sets where request_id = p_request;

  -- Designs: every one still waiting (not approved before) gets a decision
  if exists (
    select 1 from public.designs d
    where d.request_id = p_request and d.client_status is distinct from 'approved'
      and exists (select 1 from public.design_versions v join public.design_files f on f.version_id = v.id where v.design_id = d.id and v.version = d.current_version)
      and not exists (select 1 from jsonb_array_elements(p_designs) x where (x->>'design_id')::uuid = d.id)
  ) then raise exception 'Every design needs a decision'; end if;
  for v_d in select * from jsonb_array_elements(p_designs) loop
    if (v_d->>'decision') not in ('approved', 'changes') then raise exception 'Unknown decision'; end if;
    update public.designs
    set client_status = v_d->>'decision', client_version = current_version, client_decided_at = v_now
    where id = (v_d->>'design_id')::uuid and request_id = p_request and client_status is distinct from 'approved';
  end loop;

  -- Copy: every ad still waiting gets a decision; approved ones stay approved
  if s.id is not null then
    v_status := coalesce(s.client_status, '[]');
    for v_i in 0 .. jsonb_array_length(s.ads) - 1 loop
      if coalesce(v_status->v_i->>'status', '') = 'approved' then continue; end if;
      select x into v_d from jsonb_array_elements(p_ads) x where (x->>'index')::int = v_i limit 1;
      if v_d is null then raise exception 'Every copy needs a decision'; end if;
      if (v_d->>'decision') not in ('approved', 'changes') then raise exception 'Unknown decision'; end if;
      -- pad the array up to this ad, then set it
      while jsonb_array_length(v_status) <= v_i loop v_status := v_status || jsonb_build_array(jsonb_build_object('status', null)); end loop;
      v_status := jsonb_set(v_status, array[v_i::text], jsonb_build_object('status', v_d->>'decision', 'note', nullif(trim(v_d->>'note'), '')));
    end loop;
    update public.copy_sets set client_status = v_status, updated_at = v_now where id = s.id;
  end if;

  select count(*) filter (where client_status = 'approved'), count(*) filter (where client_status = 'changes')
  into v_ok_d, v_ch_d from public.designs where request_id = p_request;
  select count(*) filter (where x->>'status' = 'approved'), count(*) filter (where x->>'status' = 'changes')
  into v_ok_a, v_ch_a from jsonb_array_elements(coalesce(v_status, '[]')) x;

  select string_agg(format('%s: %s', d.name, x->>'note'), E'\n') into v_dnotes
  from jsonb_array_elements(p_designs) x join public.designs d on d.id = (x->>'design_id')::uuid
  where x->>'decision' = 'changes' and nullif(trim(x->>'note'), '') is not null;
  select string_agg(format('Ad %s: %s', (x->>'index')::int + 1, coalesce(nullif(trim(x->>'note'), ''), 'needs changes')), E'\n') into v_anotes
  from jsonb_array_elements(p_ads) x where x->>'decision' = 'changes';
  if v_ch_d > 0 then v_targets := v_targets || 'design'::text; end if;
  if v_ch_a > 0 then v_targets := v_targets || 'copy'::text; end if;

  select coalesce(max(round), 0) + 1 into v_round from public.client_rounds where request_id = p_request;
  insert into public.client_rounds (request_id, client_id, round, decision, targets, copy_notes, design_note, by_contact, by_profile, by_name)
  values (p_request, r.client_id, v_round, case when v_ch_d + v_ch_a = 0 then 'approved' else 'revise' end, v_targets, v_anotes, v_dnotes, p_by_contact, p_by_profile, p_by_name);

  -- Some approved, some not: the approved designs and copy launch from their own ticket while the rest is reworked
  if v_ch_d + v_ch_a > 0 and v_ok_d > 0 and v_ok_a > 0 and (v_ch_d > 0 or v_ok_d > 0) then
    select count(*) filter (where not is_variation), count(*) filter (where is_variation) into v_new, v_var
    from public.designs where request_id = p_request and client_status = 'approved';
    insert into public.requests (client_id, title, format, kind, priority, angle_id, audience, brief, refs, sizes, quantity, stage, stage_entered_at, stage_due_at,
                                 assignee_id, creative_id, buyer_id, requested_by, batch_id, new_count, variation_count, ai_review, landing_url, parent_id, client_summary)
    values (r.client_id, r.title || ' · approved', r.format, r.kind, r.priority, r.angle_id, r.audience, r.brief, r.refs, r.sizes, greatest(v_new + v_var, 1), 'ready_for_launch', v_now,
            private.stage_due('ready_for_launch', r.format, r.priority, v_now, r.created_at),
            coalesce(private.stage_owner(r, 'ready_for_launch'), r.buyer_id), r.creative_id, r.buyer_id, r.requested_by, r.batch_id,
            v_new, case when v_new + v_var = 0 then 1 else v_var end, r.ai_review, r.landing_url, r.id, r.client_summary)
    returning id, number into v_split, v_split_no;
    -- The original keeps only what's still being worked on, so the allotment isn't counted twice
    update public.requests
    set new_count = greatest(new_count - v_new, 0),
        variation_count = case when greatest(new_count - v_new, 0) + greatest(variation_count - v_var, 0) = 0 then 1 else greatest(variation_count - v_var, 0) end,
        quantity = greatest(quantity - v_new - v_var, 1)
    where id = p_request;
    update public.review_comments set request_id = v_split where design_id in (select id from public.designs where request_id = p_request and client_status = 'approved');
    update public.designs set request_id = v_split where request_id = p_request and client_status = 'approved';
    insert into public.copy_sets (request_id, client_id, angle_id, status, ads, ai_ads, notes, version, approved_at, client_status)
    select v_split, s.client_id, s.angle_id, 'approved',
           (select coalesce(jsonb_agg(a.value order by a.ord), '[]') from jsonb_array_elements(s.ads) with ordinality a(value, ord) where v_status->((a.ord - 1)::int)->>'status' = 'approved'),
           (select coalesce(jsonb_agg(a.value order by a.ord), '[]') from jsonb_array_elements(s.ads) with ordinality a(value, ord) where v_status->((a.ord - 1)::int)->>'status' = 'approved'),
           'Copy the client approved.', 1, v_now,
           (select coalesce(jsonb_agg(jsonb_build_object('status', 'approved')), '[]') from jsonb_array_elements(v_status) x where x->>'status' = 'approved');
    insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, data)
    values (v_split, 'review', null, 'ready_for_launch', p_by_profile, jsonb_build_object('action', 'client_split', 'from', r.number, 'by_name', p_by_name, 'designs', v_ok_d, 'ads', v_ok_a));
  end if;

  -- Where the original goes: all approved → launch; design changes → the maker; copy only → the AI amends it
  v_to := case when v_ch_d + v_ch_a = 0 then 'ready_for_launch' when v_ch_d > 0 then 'client_revision' else 'copy' end;
  update public.requests
  set stage = v_to,
      stage_entered_at = v_now,
      stage_due_at = private.stage_due(v_to, r.format, r.priority, v_now, r.created_at),
      assignee_id = case when v_to = 'copy' then null else coalesce(private.stage_owner(r, v_to), r.assignee_id) end
  where id = p_request;
  if v_ch_a > 0 then
    update public.copy_sets set status = 'drafting', client_notes = v_anotes,
      progress = jsonb_build_object('written', 0, 'total', jsonb_array_length(ads), 'label', 'Reading the client''s notes'), updated_at = v_now
    where request_id = p_request;
  end if;

  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, body, data)
  values (p_request, 'review', 'client_review', v_to, p_by_profile, concat_ws(E'\n', v_dnotes, v_anotes),
          jsonb_build_object('action', case when v_ch_d + v_ch_a = 0 then 'client_approved' else 'client_revise' end, 'targets', to_jsonb(v_targets),
                             'by_name', p_by_name, 'round', v_round, 'testing', p_by_contact is null,
                             'approved_designs', v_ok_d, 'changes_designs', v_ch_d, 'approved_ads', v_ok_a, 'changes_ads', v_ch_a, 'split', v_split_no));
  return jsonb_build_object('round', v_round, 'stage', v_to, 'split_id', v_split, 'split_number', v_split_no);
end $$;
revoke execute on function public.client_submit_review(uuid, jsonb, jsonb, uuid, uuid, text) from public, anon, authenticated;
