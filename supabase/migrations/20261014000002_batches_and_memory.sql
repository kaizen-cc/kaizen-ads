-- Kaizen Ads — request batches and client memory
-- One request form can ask for several formats. Each format is its own ticket (its own maker and turnaround),
-- grouped by batch_id. Counts are explicit: net-new designs vs variations of them.
-- Client memory holds what the team has learned about a client (what to avoid, what works) for the AI.

-- ─── Batches and counts on requests ────────────────────────────────────────
alter table public.requests
  add column batch_id        uuid,
  add column new_count       int not null default 1 check (new_count >= 0),
  add column variation_count int not null default 0 check (variation_count >= 0),
  add column ai_review       jsonb;   -- what the AI review flagged when the request was made, if anything

update public.requests set new_count = quantity, variation_count = 0;
alter table public.requests add constraint requests_counts_total check (new_count + variation_count between 1 and 100);
create index on public.requests (batch_id) where batch_id is not null;

-- ─── Client memory ─────────────────────────────────────────────────────────
create type public.memory_kind as enum ('avoid', 'prefer', 'note');

create table public.client_memory (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  kind       public.memory_kind not null default 'note',
  body       text not null check (length(trim(body)) between 1 and 1000),
  source     text not null default 'team' check (source in ('team', 'client', 'review')),
  status     public.record_status not null default 'active',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.client_memory (client_id) where status = 'active';
alter table public.client_memory enable row level security;

create policy "staff read client memory" on public.client_memory for select to authenticated
  using (private.staff_can_see_client(client_id));
create policy "staff add client memory" on public.client_memory for insert to authenticated
  with check (private.staff_can_see_client(client_id) and created_by = private.current_profile_id());
create policy "staff update client memory" on public.client_memory for update to authenticated
  using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));

-- ─── Create a batch: one ticket per format ─────────────────────────────────
-- p_items: [{"format": "image", "new": 3, "variations": 2}, ...]
create function public.create_request_batch(
  p_client uuid, p_title text, p_items jsonb,
  p_priority public.request_priority default 'normal',
  p_angle text default null, p_audience text default null, p_brief text default null,
  p_refs text[] default '{}', p_sizes text[] default '{}', p_ai_review jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
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

    v_creative := null;
    select profile_id into v_creative from public.client_assignments
    where client_id = p_client and role = (case when v_format = 'video' then 'video_editor' else 'graphic_designer' end)::public.assignment_role
    limit 1;

    insert into public.requests (
      batch_id, client_id, title, format, kind, priority, angle_id, audience, brief, refs, sizes,
      quantity, new_count, variation_count, ai_review,
      stage, stage_entered_at, stage_due_at, assignee_id, creative_id, buyer_id, requested_by, created_at
    ) values (
      v_batch, p_client, trim(p_title), v_format, case when v_new = 0 then 'iteration' else 'new' end::public.request_kind,
      p_priority, v_angle, nullif(trim(p_audience), ''), nullif(trim(p_brief), ''), coalesce(p_refs, '{}'), coalesce(p_sizes, '{}'),
      v_new + v_var, v_new, v_var, p_ai_review,
      'requested', v_now, private.stage_due('requested', v_format, p_priority, v_now, v_now),
      v_creative, v_creative, v_buyer, v_me, v_now
    ) returning id into v_id;

    insert into public.request_events (request_id, kind, to_stage, actor_id)
    values (v_id, 'created', 'requested', v_me);
  end loop;

  return v_batch;
end $$;

revoke execute on function public.create_request_batch(uuid, text, jsonb, public.request_priority, text, text, text, text[], text[], jsonb) from public, anon;
grant execute on function public.create_request_batch(uuid, text, jsonb, public.request_priority, text, text, text, text[], text[], jsonb) to authenticated;

-- ─── The board view picks up the new columns (r.* is fixed when a view is created) ─
drop view public.board_requests;
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
