-- Designs: add, version, record files, folder guard, who can see them.
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
  c_x uuid; c_y uuid; p_d uuid; p_o uuid; a_d uuid; a_o uuid; t uuid; res jsonb; d1 uuid; v1 uuid; v2 jsonb; n int; pre text;
  results jsonb := '[]';
begin
 begin
  insert into public.clients (name, slug, creative_package) values ('ZZ Design Client', 'zz-design-x', true) returning id into c_x;
  insert into public.clients (name, slug, creative_package) values ('ZZ Design Other', 'zz-design-y', true) returning id into c_y;
  insert into public.profiles (email, full_name, role) values ('zz-dd@kaizenmarketing.agency', 'ZZ Designer', 'graphic_designer') returning id into p_d;
  insert into public.profiles (email, full_name, role) values ('zz-do@kaizenmarketing.agency', 'ZZ Other', 'graphic_designer') returning id into p_o;
  insert into public.client_assignments (client_id, profile_id, role) values (c_x, p_d, 'graphic_designer'), (c_y, p_o, 'graphic_designer');
  a_d := pg_temp.new_auth('zz-dd@kaizenmarketing.agency');
  a_o := pg_temp.new_auth('zz-do@kaizenmarketing.agency');

  perform pg_temp.act_as(a_d);
  t := public.create_request(c_x, 'Uploads', 'image');
  res := public.add_designs(t, '[{"name":"Calzone pull"},{"name":"Price first"}]'::jsonb);
  d1 := (res->0->>'design_id')::uuid;
  v1 := (res->0->>'version_id')::uuid;
  results := results || jsonb_build_object('test', 'two designs numbered D1 and D2', 'ok', (res->1->>'position')::int = 2, 'detail', res::text);

  pre := c_x || '/' || t || '/' || d1 || '/v1/';
  perform public.record_design_files(v1, jsonb_build_array(jsonb_build_object('path', pre || 'a.jpg', 'original_name', 'a_4x5.jpg', 'mime', 'image/jpeg', 'bytes', 1000, 'width', 1080, 'height', 1350, 'aspect', '4x5')));
  results := results || jsonb_build_object('test', 'files recorded on the version', 'ok', (select count(*) from public.design_files where version_id = v1) = 1, 'detail', '');

  begin
    perform public.record_design_files(v1, jsonb_build_array(jsonb_build_object('path', c_y || '/x/y/v1/evil.jpg', 'original_name', 'e', 'mime', 'image/jpeg', 'bytes', 1)));
    results := results || jsonb_build_object('test', 'files must sit in the design''s own folder', 'ok', false, 'detail', 'recorded');
  exception when others then
    results := results || jsonb_build_object('test', 'files must sit in the design''s own folder', 'ok', true, 'detail', sqlerrm);
  end;

  v2 := public.add_design_version(d1, 'Bigger logo');
  results := results || jsonb_build_object('test', 'replace makes v2 and keeps v1',
    'ok', (v2->>'version')::int = 2 and (select current_version from public.designs where id = d1) = 2 and (select count(*) from public.design_versions where design_id = d1) = 2, 'detail', v2::text);

  res := public.add_designs(t, jsonb_build_array(jsonb_build_object('name', 'CTA test', 'variation_of', d1)));
  results := results || jsonb_build_object('test', 'a variation points at its design',
    'ok', (select is_variation and variation_of = d1 from public.designs where id = (res->0->>'design_id')::uuid), 'detail', '');

  perform pg_temp.act_as(a_o);
  select count(*) into n from public.designs where request_id = t;
  results := results || jsonb_build_object('test', 'people off the client can''t see its designs', 'ok', n = 0, 'detail', n || ' visible');
  begin
    perform public.add_design_version(d1, 'sneaky');
    results := results || jsonb_build_object('test', 'people off the client can''t add versions', 'ok', false, 'detail', 'added');
  exception when others then
    results := results || jsonb_build_object('test', 'people off the client can''t add versions', 'ok', true, 'detail', sqlerrm);
  end;
  results := results || jsonb_build_object('test', 'storage path maps to its client', 'ok', private.path_client(pre || 'a.jpg') = c_x, 'detail', '');

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
