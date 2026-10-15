-- Kaizen Ads — the creative check on upload
-- Before files upload, the AI looks at them: which sizes came in, which designs are really one design in another
-- size, and which are variations rather than net new. Two things it needs from the database:
--   1. a design can be a variation of another design in the same upload (variation_of_index)
--   2. the ticket's counts (net new vs variations) can be corrected, which is what the allotment counts, logged

-- ─── 1. Variations of a design in the same upload ───────────────────────────
-- p_designs: [{"name": "Calzone pull", "variation_of": null, "variation_of_index": null}, …]
-- variation_of_index points at an earlier design in the same list.
create or replace function public.add_designs(p_request uuid, p_designs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r     public.requests := private.assert_can_work(p_request);
  v_me  uuid := private.current_profile_id();
  v_pos int;
  v_d   jsonb;
  v_i   int := 0;
  v_ids uuid[] := '{}';
  v_id  uuid;
  v_ver uuid;
  v_of  uuid;
  v_idx int;
  out   jsonb := '[]';
begin
  if jsonb_typeof(p_designs) <> 'array' or jsonb_array_length(p_designs) = 0 then raise exception 'Nothing to upload'; end if;
  select coalesce(max(position), 0) into v_pos from public.designs where request_id = p_request;
  for v_d in select * from jsonb_array_elements(p_designs) loop
    v_pos := v_pos + 1;
    v_of := nullif(v_d->>'variation_of', '')::uuid;
    v_idx := nullif(v_d->>'variation_of_index', '')::int;
    if v_of is null and v_idx is not null then
      if v_idx < 0 or v_idx >= v_i then raise exception 'A variation must come after the design it varies'; end if;
      v_of := v_ids[v_idx + 1];
    end if;
    if v_of is not null and not exists (select 1 from public.designs where id = v_of and request_id = p_request) then
      raise exception 'A variation must be of a design on the same ticket';
    end if;
    insert into public.designs (request_id, client_id, position, name, variation_of, is_variation, created_by)
    values (p_request, r.client_id, v_pos, coalesce(nullif(trim(v_d->>'name'), ''), 'Design ' || v_pos), v_of,
            v_of is not null or coalesce((v_d->>'is_variation')::boolean, false), v_me)
    returning id into v_id;
    v_ids := v_ids || v_id;
    v_i := v_i + 1;
    insert into public.design_versions (design_id, version, created_by) values (v_id, 1, v_me) returning id into v_ver;
    out := out || jsonb_build_object('design_id', v_id, 'version_id', v_ver, 'version', 1, 'position', v_pos);
  end loop;
  insert into public.request_events (request_id, kind, actor_id, data)
  values (p_request, 'upload', v_me, jsonb_build_object('designs', jsonb_array_length(p_designs)));
  return out;
end $$;

-- ─── 2. Correct a ticket's counts ───────────────────────────────────────────
-- Net new counts toward the client's allotment; variations don't. Logged on the ticket with who and why.
create function public.set_request_counts(p_request uuid, p_new int, p_variations int, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.requests := private.assert_can_work(p_request);
begin
  if p_new < 0 or p_variations < 0 or p_new + p_variations not between 1 and 100 then
    raise exception 'Counts must add up to between 1 and 100';
  end if;
  if r.new_count = p_new and r.variation_count = p_variations then return; end if;
  update public.requests set new_count = p_new, variation_count = p_variations, quantity = p_new + p_variations where id = p_request;
  insert into public.request_events (request_id, kind, actor_id, body, data)
  values (p_request, 'upload', private.current_profile_id(), nullif(trim(p_reason), ''),
          jsonb_build_object('action', 'counts', 'from_new', r.new_count, 'from_variations', r.variation_count, 'new', p_new, 'variations', p_variations));
end $$;
revoke execute on function public.set_request_counts(uuid, int, int, text) from public, anon;
grant execute on function public.set_request_counts(uuid, int, int, text) to authenticated;

-- ─── 3. The agent ───────────────────────────────────────────────────────────
insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('creativecheck', 'Creative check', 'Looks at creative as it''s uploaded: which designs are the same idea in another size, which are variations rather than net new, and whether that matches what the ticket asked for (net new counts toward the allotment).', 'sonnet', 'low', true, 9, 'eye', '{}')
on conflict (key) do nothing;
