-- The creative allotment counts every version (owner's policy, Nov 5 2026).
-- * A brief is ONE concept; several distinct concepts are several briefs.
-- * Every version of the concept counts (net new and each variation; variations used to be free), a carousel once
--   per slide. Sizes of one version (4:5, 9:16) are free, and so are copy-only edits and print or organic-only work.
-- requests.allotment_units holds what each ticket takes (generated, so every row, old and new, is counted the same way
-- whatever path made it); client_allotment_usage sums it. Asana tasks are recounted by the AI counter under the new
-- rule (src/lib/asana.ts, a new rule version in units_key), which also notes when one task bundles several concepts
-- (asana_tasks.concepts). The agents' stored knowledge that said variations are free, or a carousel is one piece or
-- half a piece per slide, now says the rule.

-- ─── What each ticket takes ──────────────────────────────────────────────────
alter table public.requests add column if not exists allotment_units int generated always as (
  (greatest(coalesce(new_count, 0), 0) + greatest(coalesce(variation_count, 0), 0))
  * case when format = 'carousel'::public.creative_format then least(10, greatest(2, coalesce(cards, 5))) else 1 end
) stored;
comment on column public.requests.allotment_units is 'What this ticket takes from the monthly allotment: every version (net new + variations), a carousel once per slide (cards, 5 when unset); sizes are free';

-- ─── Asana tasks that bundle several concepts ────────────────────────────────
alter table public.asana_tasks add column if not exists concepts int;
comment on column public.asana_tasks.concepts is 'How many distinct concepts the task asks for (read with the allotment count); more than 1 should have been that many briefs';

-- ─── Requests: a carousel item carries its slides ────────────────────────────
create or replace function private.create_request_batch_unchecked(p_client uuid, p_title text, p_items jsonb, p_priority request_priority DEFAULT 'normal'::request_priority, p_angle text DEFAULT NULL::text, p_audience text DEFAULT NULL::text, p_brief text DEFAULT NULL::text, p_refs text[] DEFAULT '{}'::text[], p_sizes text[] DEFAULT '{}'::text[], p_ai_review jsonb DEFAULT NULL::jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_me       uuid := private.current_profile_id();
  v_batch    uuid := gen_random_uuid();
  v_buyer    uuid;
  v_angle    uuid;
  v_creative uuid;
  v_id       uuid;
  v_now      timestamptz := now();
  v_item     jsonb;
  v_format   public.creative_format;
  v_new      int;
  v_var      int;
  v_cards    int;
  v_seen     public.creative_format[] := '{}';
begin
  if v_me is null or not private.staff_can_see_client(p_client) then
    raise exception 'You can only request creative for clients you work on';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'Give the request a title';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Pick at least one format';
  end if;

  select profile_id into v_buyer from public.client_assignments
  where client_id = p_client and role = 'meta_buyer' limit 1;

  if nullif(trim(p_angle), '') is not null then
    insert into public.angles (client_id, name, source, created_by)
    values (p_client, trim(p_angle), 'request', v_me)
    on conflict (client_id, name) do update set status = 'active'
    returning id into v_angle;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_format := (v_item->>'format')::public.creative_format;
    if v_format = any(v_seen) then
      raise exception 'Each format can only appear once in a request';
    end if;
    v_seen := v_seen || v_format;
    v_new := greatest(coalesce((v_item->>'new')::int, 0), 0);
    v_var := greatest(coalesce((v_item->>'variations')::int, 0), 0);
    if v_new + v_var not between 1 and 100 then
      raise exception 'Each format needs between 1 and 100 creatives';
    end if;
    -- A carousel's slides (each one counts toward the allotment); 5 when the item doesn't say
    v_cards := case when v_format = 'carousel' then least(10, greatest(2, coalesce((v_item->>'cards')::int, 5))) end;

    v_creative := null;
    select profile_id into v_creative from public.client_assignments
    where client_id = p_client and role = (case when v_format = 'video' then 'video_editor' else 'graphic_designer' end)::public.assignment_role
    limit 1;

    insert into public.requests (
      batch_id, client_id, title, format, kind, priority, angle_id, audience, brief, refs, sizes,
      quantity, new_count, variation_count, cards, ai_review,
      stage, stage_entered_at, stage_due_at, assignee_id, creative_id, buyer_id, requested_by, created_at
    ) values (
      v_batch, p_client, trim(p_title), v_format, case when v_new = 0 then 'iteration' else 'new' end::public.request_kind,
      p_priority, v_angle, nullif(trim(p_audience), ''), nullif(trim(p_brief), ''), coalesce(p_refs, '{}'), coalesce(p_sizes, '{}'),
      v_new + v_var, v_new, v_var, v_cards, p_ai_review,
      'requested', v_now, private.stage_due('requested', v_format, p_priority, v_now, v_now),
      v_creative, v_creative, v_buyer, v_me, v_now
    ) returning id into v_id;

    insert into public.request_events (request_id, kind, to_stage, actor_id)
    values (v_id, 'created', 'requested', v_me);
  end loop;

  return v_batch;
end $function$;

-- ─── This cycle's use: every version, a carousel per slide ───────────────────
create or replace view public.client_allotment_usage with (security_invoker = on) as
 with cycle as (
         select c_1.id as client_id,
            allotment_period_start(c_1.billing_day::integer) as starts
           from clients c_1
        ), ours as (
         select r.client_id,
            sum(r.allotment_units) filter (where r.format = any (array['image'::creative_format, 'carousel'::creative_format])) as images,
            sum(r.allotment_units) filter (where r.format = 'video'::creative_format) as videos
           from requests r
             join cycle y_1 on y_1.client_id = r.client_id
             left join asana_tasks m on m.request_id = r.id
          where r.deleted_at is null and
                case
                    when m.counted_at is not null then m.counted_at >= y_1.starts
                    else coalesce(m.asana_created_at, r.created_at) >= y_1.starts
                end
          group by r.client_id
        ), asana as (
         select t.client_id,
            sum(coalesce(t.new_images,
                case
                    when t.format = any (array['image'::text, 'carousel'::text]) then 1
                    else 0
                end)) filter (where t.counted_at >= y_1.starts) as images,
            sum(coalesce(t.new_videos,
                case
                    when t.format = 'video'::text then 1
                    else 0
                end)) filter (where t.counted_at >= y_1.starts) as videos,
            sum(coalesce(t.new_images,
                case
                    when t.format = any (array['image'::text, 'carousel'::text]) then 1
                    else 0
                end)) filter (where t.counted_at is null and t.open and t.stage = 'requested'::text) as waiting_images,
            sum(coalesce(t.new_videos,
                case
                    when t.format = 'video'::text then 1
                    else 0
                end)) filter (where t.counted_at is null and t.open and t.stage = 'requested'::text) as waiting_videos
           from asana_tasks t
             join cycle y_1 on y_1.client_id = t.client_id
          where t.request_id is null
          group by t.client_id
        )
 select c.id as client_id,
    a.images_per_month,
    a.videos_per_month,
    (coalesce(o.images, 0::bigint) + coalesce(s.images, 0::bigint))::integer as images_used,
    (coalesce(o.videos, 0::bigint) + coalesce(s.videos, 0::bigint))::integer as videos_used,
    c.creative_package_until as package_until,
    coalesce(s.images, 0::bigint)::integer as asana_images,
    coalesce(s.videos, 0::bigint)::integer as asana_videos,
    coalesce(s.waiting_images, 0::bigint)::integer as asana_waiting_images,
    coalesce(s.waiting_videos, 0::bigint)::integer as asana_waiting_videos,
    c.billing_day,
    (y.starts at time zone 'America/New_York'::text)::date as period_start,
    ((y.starts at time zone 'America/New_York'::text)::date + '1 mon'::interval)::date as period_end
   from clients c
     join cycle y on y.client_id = c.id
     left join client_allotments a on a.client_id = c.id
     left join ours o on o.client_id = c.id
     left join asana s on s.client_id = c.id
  where c.creative_package and c.archived_at is null and (c.creative_package_until is null or c.creative_package_until >= (now() at time zone 'America/New_York'::text)::date);

-- ─── What the agents know: the rule, wherever it said otherwise ─────────────
update public.ai_knowledge set body = replace(replace(body,
  'Deliverables: a net new creative is a distinct design. A variation reuses the same design and tests copy, headline, CTA or layout, and doesn''t count as a new deliverable. A carousel counts as one deliverable. Sizes of one design count as one.',
  'Deliverables: one concept per brief (several distinct concepts are several briefs). A net new creative is a distinct design of that concept; a variation is another version of it that tests copy, headline, CTA or layout. Every version counts toward the allotment, net new and variations alike, and a carousel counts once per slide. Sizes of one version (4:5 and 9:16) count as one. Copy-only edits and print or organic-only work don''t count.'),
  'Creative packages (monthly net new allotment, images include carousels)',
  'Creative packages (monthly allotment: every version counts, carousels once per slide and in the image pool)')
where agent_key is null and title = 'How Kaizen works';

update public.ai_knowledge set body = replace(replace(replace(body,
  '- Count only net new against the allotment; images and carousels share the image pool.',
  '- One concept per brief. Every version counts against the allotment (net new and variations), a carousel once per slide; sizes don''t. Images and carousels share the image pool.'),
  'they''re free against the allotment.',
  'each one counts against the allotment like a net new design, so plan them deliberately.'),
  '- If the allotment is used up, suggest variations only and say the client would need an upgrade or a sprint for more net new.',
  '- If the allotment is used up, say the client would need an upgrade or a sprint for more (variations count too).')
where agent_key = 'suggest' and title = 'Planning the mix within the allotment';

update public.ai_knowledge set body = replace(body,
  'ALLOTMENT: net new counts; images and carousels share the image pool; iterations count toward the month''s deliverables; variations (up to 5 per format, testing hooks and on-image headlines on a proven design) are free.',
  'ALLOTMENT: one concept per brief; every version counts (net new, iterations and variations, up to 5 variations per format testing hooks and on-image headlines on a proven design), a carousel once per slide, sizes free; images and carousels share the image pool.')
where agent_key = 'suggest' and title = 'Planning the mix within the allotment';

update public.ai_knowledge set body = replace(body,
  'SCOPE: singles 1 per design, carousels 0.5 per slide rounded up, videos 1; NEW and ITERATIONS count;',
  'SCOPE: one concept per brief; singles 1 per version (not per size), carousels 1 per slide, videos 1 per version; NEW, ITERATIONS and variations all count;')
where agent_key = 'suggest' and title = 'Production-ready items: what a designer needs';

update public.ai_knowledge set body = replace(body,
  'SCOPE per client per month: single static = 1 per design (not per size); carousel = 0.5 per slide, rounded up; video = 1; NEW and ITERATIONS both count.',
  'SCOPE per client per month: single static = 1 per version (not per size); carousel = 1 per slide; video = 1 per version; NEW, ITERATIONS and variations all count. One concept per brief: a ticket that bundles several distinct concepts is flagged (it should have been that many briefs).')
where agent_key = 'creativecheck' and title = 'Delivery check: matching, sizes, names, folders and scope';

update public.ai_knowledge set body = replace(body,
  '1. Package and allotment: active package (or sprint not ended), net new within what''s left, due before any sprint end.',
  '1. Package and allotment: active package (or sprint not ended), every version within what''s left (variations count, a carousel once per slide; sizes don''t), one concept per request (several distinct concepts are split into separate briefs), due before any sprint end.')
where agent_key = 'review' and title = 'Review checklist';

update public.ai_knowledge set body = replace(body,
  'Use the month''s allotment to show range: distinct angles, not variations of one idea.',
  'Use the month''s allotment to show range: distinct angles, not variations of one idea. Each concept is its own brief, and every version of it counts toward the allotment.')
where agent_key = 'strategist' and title = 'First round for a new client';

-- The older wording of the same checklist (the one written before the six agents)
update public.ai_knowledge set body = replace(body,
  '1. Package and allotment: active package (or sprint not ended), net new within what''s left, due date before any sprint end.',
  '1. Package and allotment: active package (or sprint not ended), every version within what''s left (variations count, a carousel once per slide; sizes don''t), one concept per request (several distinct concepts are split into separate briefs), due date before any sprint end.')
where agent_key = 'review' and title = 'Review checklist';
