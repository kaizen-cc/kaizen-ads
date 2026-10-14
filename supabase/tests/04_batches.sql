-- Batches: one ticket per format, explicit counts, routing; client memory visibility.
-- Builds its own fixtures and always rolls them back (the test block ends by raising).
begin;

create function pg_temp.act_as(p_auth uuid) returns void language plpgsql as $$
begin
  reset role;
  if p_auth is null then perform set_config('request.jwt.claims', '', true); return; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', p_auth, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

create function pg_temp.new_auth(p_email text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (v, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, '{}', now(), now());
  return v;
end $$;

create function pg_temp.run() returns table (test text, ok boolean, detail text) language plpgsql as $$
declare
  c_x uuid; c_y uuid; p_buyer uuid; p_designer uuid; p_editor uuid; p_other uuid;
  a_buyer uuid; a_other uuid; b uuid; n int; img public.requests; vid public.requests; car public.requests;
  results jsonb := '[]';
begin
 begin
  insert into public.clients (name, slug) values ('ZZ Batch Client', 'zz-batch-x') returning id into c_x;
  insert into public.clients (name, slug) values ('ZZ Batch Other', 'zz-batch-y') returning id into c_y;
  insert into public.profiles (email, full_name, role) values ('zz-bb@kaizenmarketing.agency', 'ZZ Buyer', 'media_buyer') returning id into p_buyer;
  insert into public.profiles (email, full_name, role) values ('zz-bd@kaizenmarketing.agency', 'ZZ Designer', 'graphic_designer') returning id into p_designer;
  insert into public.profiles (email, full_name, role) values ('zz-be@kaizenmarketing.agency', 'ZZ Editor', 'video_editor') returning id into p_editor;
  insert into public.profiles (email, full_name, role) values ('zz-bo@kaizenmarketing.agency', 'ZZ Other', 'media_buyer') returning id into p_other;
  insert into public.client_assignments (client_id, profile_id, role) values
    (c_x, p_buyer, 'meta_buyer'), (c_x, p_designer, 'graphic_designer'), (c_x, p_editor, 'video_editor'), (c_y, p_other, 'meta_buyer');
  a_buyer := pg_temp.new_auth('zz-bb@kaizenmarketing.agency');
  a_other := pg_temp.new_auth('zz-bo@kaizenmarketing.agency');

  perform pg_temp.act_as(a_buyer);
  b := public.create_request_batch(c_x, 'BFCM', '[{"format":"image","new":3,"variations":2},{"format":"video","new":1,"variations":0},{"format":"carousel","new":0,"variations":2}]'::jsonb,
    'high', 'Doorbusters', 'Past buyers', 'Lead with 40% off', '{}', '{1x1,9x16}', '{"issues":[]}'::jsonb);
  select count(*) into n from public.requests where batch_id = b;
  results := results || jsonb_build_object('test', 'three formats make three tickets', 'ok', n = 3, 'detail', n::text);
  select * into img from public.requests where batch_id = b and format = 'image';
  select * into vid from public.requests where batch_id = b and format = 'video';
  select * into car from public.requests where batch_id = b and format = 'carousel';
  results := results || jsonb_build_object('test', 'image ticket goes to the designer', 'ok', img.assignee_id = p_designer, 'detail', '');
  results := results || jsonb_build_object('test', 'video ticket goes to the editor', 'ok', vid.assignee_id = p_editor, 'detail', '');
  results := results || jsonb_build_object('test', 'counts are kept: 3 new + 2 variations = 5', 'ok', img.new_count = 3 and img.variation_count = 2 and img.quantity = 5, 'detail', '');
  results := results || jsonb_build_object('test', 'variations only is an iteration', 'ok', car.kind = 'iteration' and img.kind = 'new', 'detail', car.kind::text);
  results := results || jsonb_build_object('test', 'each format has its own turnaround',
    'ok', vid.stage_due_at > img.stage_due_at, 'detail', '');
  results := results || jsonb_build_object('test', 'batch shows on the board view',
    'ok', (select count(*) from public.board_requests where batch_id = b) = 3, 'detail', '');

  begin
    perform public.create_request_batch(c_x, 'Dup', '[{"format":"image","new":1},{"format":"image","new":1}]'::jsonb);
    results := results || jsonb_build_object('test', 'a format cannot repeat in one batch', 'ok', false, 'detail', 'created');
  exception when others then
    results := results || jsonb_build_object('test', 'a format cannot repeat in one batch', 'ok', true, 'detail', sqlerrm);
  end;
  begin
    perform public.create_request_batch(c_x, 'Zero', '[{"format":"image","new":0,"variations":0}]'::jsonb);
    results := results || jsonb_build_object('test', 'a format needs at least one creative', 'ok', false, 'detail', 'created');
  exception when others then
    results := results || jsonb_build_object('test', 'a format needs at least one creative', 'ok', true, 'detail', sqlerrm);
  end;

  insert into public.client_memory (client_id, kind, body, created_by) values (c_x, 'avoid', 'Never show the old logo', p_buyer);
  perform pg_temp.act_as(a_other);
  select count(*) into n from public.client_memory where client_id = c_x;
  results := results || jsonb_build_object('test', 'memory is hidden from people off the client', 'ok', n = 0, 'detail', n || ' visible');
  begin
    perform public.create_request_batch(c_x, 'Nope', '[{"format":"image","new":1}]'::jsonb);
    results := results || jsonb_build_object('test', 'cannot batch for another client', 'ok', false, 'detail', 'created');
  exception when others then
    results := results || jsonb_build_object('test', 'cannot batch for another client', 'ok', true, 'detail', sqlerrm);
  end;

  perform pg_temp.act_as(null);
  raise exception 'rollback fixtures';
 exception when others then
  if sqlerrm <> 'rollback fixtures' then
    results := results || jsonb_build_object('test', 'tests ran to the end', 'ok', false, 'detail', sqlerrm);
  end if;
 end;
 return query select x.test, x.ok, x.detail from jsonb_to_recordset(results) as x(test text, ok boolean, detail text);
end $$;

select * from pg_temp.run();
