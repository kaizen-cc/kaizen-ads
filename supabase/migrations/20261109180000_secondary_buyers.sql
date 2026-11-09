-- Secondary buyers (owner's request, Nov 9 2026): an account can have more than one buyer. Each seat on a client
-- (client_assignments, one row per person) is the primary or a secondary. The primary is who a task picks when it
-- needs one owner (the KPI card, a report part, a sprint, a ticket's buyer); a secondary sees the client, its KPI cards
-- and reports, can do what the seat allows, and is copied on the updates and alerts the primary gets.
-- Every existing row is the primary (default true). Where a seat already has several people (Team from the form allows
-- it), the one who owns the client's KPI card on that platform stays primary, else whoever was on it first.

alter table public.client_assignments add column if not exists is_primary boolean not null default true;
comment on column public.client_assignments.is_primary is 'The seat''s primary (true) or a secondary (false); one primary per client and role';

with ranked as (
  select a.client_id, a.role, a.profile_id,
         row_number() over (
           partition by a.client_id, a.role
           order by (a.role in ('meta_buyer', 'google_buyer') and exists (
                      select 1 from public.kpi_targets t
                       where t.client_id = a.client_id and t.active and t.owner_id = a.profile_id
                         and t.platform = case when a.role = 'google_buyer' then 'google' else 'meta' end)) desc,
                    a.created_at, a.profile_id
         ) as n
    from public.client_assignments a
)
update public.client_assignments a
   set is_primary = false
  from ranked r
 where r.client_id = a.client_id and r.role = a.role and r.profile_id = a.profile_id and r.n > 1;

create unique index if not exists client_assignments_one_primary on public.client_assignments (client_id, role) where is_primary;

-- ─── Copy the secondaries in ────────────────────────────────────────────────
-- A client's secondary buyers on one platform (everyone on the seat but its primary)
create or replace function private.secondary_buyers(p_client uuid, p_platform text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select profile_id from public.client_assignments
   where client_id = p_client and not is_primary
     and role = (case when p_platform = 'google' then 'google_buyer' else 'meta_buyer' end)::public.assignment_role
$$;
revoke all on function private.secondary_buyers(uuid, text) from public, anon;

-- "You're on a client": a secondary hears they're the secondary
create or replace function private.notify_assignment() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_client text; v_slug text;
begin
  select name, slug into v_client, v_slug from public.clients where id = new.client_id;
  perform private.notify(new.profile_id, 'client', format('You''re on %s', v_client),
    format('As the %s%s', case when new.is_primary then '' else 'secondary ' end, replace(new.role::text, '_', ' ')),
    format('/clients/%s', v_slug), new.client_id, format('ca:%s:%s:%s', new.client_id, new.role, new.profile_id), 'normal');
  return new;
end $$;

-- An account went off target: its KPI owner, and the client's secondary buyers on that platform
create or replace function private.notify_kpi() returns trigger language plpgsql security definer set search_path = '' as $$
declare t public.kpi_targets; v_client text; v_slug text; v_high boolean; p uuid;
begin
  if new.status::text = 'off' and (tg_op = 'INSERT' or old.status::text is distinct from 'off') then
    select * into t from public.kpi_targets where id = new.target_id;
    if t.id is null or not t.active then return new; end if;
    select name, slug into v_client, v_slug from public.clients where id = t.client_id;
    v_high := lower(coalesce(t.sheet->>'priority', '')) = 'high';
    if t.owner_id is not null then
      for p in select t.owner_id union select * from private.secondary_buyers(t.client_id, t.platform) loop
        perform private.notify(p, 'kpi', format('%s went off target', v_client), format('%s%% off its KPI target. Worth a look before it slides further.', round(coalesce(new.deviation, 0) * 100)),
          format('/kpis?client=%s', v_slug), t.client_id, format('off:%s:%s', t.id, to_char(now(), 'YYYY-MM-DD')), case when v_high then 'critical' else 'normal' end);
      end loop;
    end if;
    if v_high then
      for p in select * from private.managers() loop
        perform private.notify(p, 'kpi', format('%s (high priority) went off target', v_client), format('%s%% off its KPI target.', round(coalesce(new.deviation, 0) * 100)),
          format('/kpis?client=%s', v_slug), t.client_id, format('off:%s:%s', t.id, to_char(now(), 'YYYY-MM-DD')), 'critical');
      end loop;
    end if;
  end if;
  return new;
end $$;

-- A sprint check-in: the sprint's buyer, and the client's secondary buyers on that account's platform
create or replace function private.notify_sprint_check() returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.optimization_sprints; v_client text; v_platform text; p uuid;
begin
  select * into s from public.optimization_sprints where id = new.sprint_id;
  if s.id is null then return new; end if;
  select name into v_client from public.clients where id = s.client_id;
  select platform into v_platform from public.kpi_targets where id = s.target_id;
  if s.buyer_id is null then return new; end if;
  for p in select s.buyer_id union select * from private.secondary_buyers(s.client_id, coalesce(v_platform, 'meta')) loop
    perform private.notify(p, 'sprint', format('Sprint check-in on %s', v_client), 'The AI looked at what changed since the last check. Open the sprint for its notes.',
      format('/kpis/sprint/%s', s.id), s.client_id, format('check:%s', new.id), 'normal');
  end loop;
  return new;
end $$;

-- A ticket's updates: everyone on it as before, and the client's secondary Meta buyers when it has a buyer
create or replace function private.notify_request_event() returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.requests; v_client text; v_actor text; v_title text; v_body text; v_priority text := 'normal'; p uuid;
begin
  if new.kind not in ('stage', 'comment', 'review', 'copy', 'upload') then return new; end if;
  select * into r from public.requests where id = new.request_id;
  if r.id is null then return new; end if;
  select name into v_client from public.clients where id = r.client_id;
  select full_name into v_actor from public.profiles where id = new.actor_id;
  if new.kind = 'stage' then
    v_title := format('#%s moved to %s', r.number, private.stage_label(new.to_stage::text));
    v_body := format('%s · %s', v_client, r.title);
    if new.to_stage::text = 'client_revision' then v_title := format('The client asked for changes on #%s', r.number); v_priority := 'critical'; end if;
    if new.to_stage::text = 'ready_for_launch' then v_title := format('#%s is approved and ready to launch', r.number); end if;
  elsif new.kind = 'comment' then
    v_title := format('%s commented on #%s', coalesce(v_actor, case when new.actor_id is null then 'Kaizen Ads' else 'Someone' end), r.number);
    v_body := coalesce(new.body, r.title);
  elsif new.kind = 'review' then
    v_title := format('#%s was reviewed: %s', r.number, coalesce(new.data->>'decision', 'see the notes'));
    v_body := format('%s · %s', v_client, r.title);
  elsif new.kind = 'copy' then
    v_title := format('Copy updated on #%s', r.number);
    v_body := format('%s · %s', v_client, r.title);
  else
    v_title := format('New upload on #%s', r.number);
    v_body := format('%s · %s', v_client, r.title);
  end if;
  for p in
    select distinct x from unnest(array[r.assignee_id, r.buyer_id, r.creative_id, r.requested_by]) x where x is not null
    union select b from private.secondary_buyers(r.client_id, 'meta') b where r.buyer_id is not null
  loop
    perform private.notify(p, 'ticket', v_title, v_body, format('/board?t=%s', r.number), r.client_id, format('ev:%s', new.id), v_priority);
  end loop;
  return new;
end $$;

-- ─── A new ticket's buyer is the client's primary Meta buyer ─────────────────
-- (was: any one of them). The rest of create_request_batch_unchecked is as it was (20261105180000).
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
  where client_id = p_client and role = 'meta_buyer' order by is_primary desc, created_at limit 1;

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
    order by is_primary desc, created_at
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
