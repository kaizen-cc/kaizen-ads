-- Access rules: clients only see their own brands; team members see what they work on.
-- Builds its own fixtures (two clients, a contact, a buyer, a coordinator, an exec) and always
-- rolls them back (the test block ends by raising), so it's safe on production.
begin;

-- Act as a signed-in user (auth user id), through the API's `authenticated` role.
create function pg_temp.act_as(p_auth uuid) returns void language plpgsql as $$
begin
  reset role;
  if p_auth is null then
    perform set_config('request.jwt.claims', '', true);
    return;
  end if;
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
  c_x uuid; c_y uuid; k_id uuid;
  a_contact uuid; a_buyer uuid; a_coord uuid; a_exec uuid;
  p_buyer uuid;
  n int; msg text;
  results jsonb := '[]';   -- plpgsql variables survive the rollback below; table changes don't
begin
 begin
  -- Fixtures
  insert into public.clients (name, slug) values ('Test Client X', 'zz-test-x') returning id into c_x;
  insert into public.clients (name, slug) values ('Test Client Y', 'zz-test-y') returning id into c_y;
  insert into public.contacts (email) values ('zz-owner@example.com') returning id into k_id;
  insert into public.contact_clients (contact_id, client_id) values (k_id, c_x);
  insert into public.profiles (email, full_name, role) values ('zz-buyer@kaizenmarketing.agency', 'ZZ Buyer', 'media_buyer') returning id into p_buyer;
  insert into public.profiles (email, full_name, role) values ('zz-coord@kaizenmarketing.agency', 'ZZ Coord', 'customer_success');
  insert into public.profiles (email, full_name, role) values ('zz-exec@kaizenmarketing.agency', 'ZZ Exec', 'executive');
  insert into public.client_assignments (client_id, profile_id, role) values (c_x, p_buyer, 'meta_buyer');

  a_contact := pg_temp.new_auth('zz-owner@example.com');
  a_buyer   := pg_temp.new_auth('zz-buyer@kaizenmarketing.agency');
  a_coord   := pg_temp.new_auth('zz-coord@kaizenmarketing.agency');
  a_exec    := pg_temp.new_auth('zz-exec@kaizenmarketing.agency');

  test := 'sign-in links the contact and the team members';
  ok := (select auth_user_id from public.contacts where id = k_id) = a_contact
    and (select auth_user_id from public.profiles where id = p_buyer) = a_buyer;
  detail := ''; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);

  -- Strangers can't sign in
  begin
    perform pg_temp.new_auth('zz-stranger@example.com');
    test := 'unknown email is rejected'; ok := false; detail := 'insert succeeded'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  exception when others then
    test := 'unknown email is rejected'; ok := sqlerrm like 'Not a client contact%'; detail := sqlerrm; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  end;
  begin
    perform pg_temp.new_auth('zz-uninvited@kaizenmarketing.agency');
    test := 'uninvited Kaizen email is rejected'; ok := false; detail := 'insert succeeded'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  exception when others then
    test := 'uninvited Kaizen email is rejected'; ok := sqlerrm like 'No invitation found%'; detail := sqlerrm; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  end;

  -- Client contact
  perform pg_temp.act_as(a_contact);
  select count(*) into n from public.clients where id in (c_x, c_y);
  test := 'contact sees only their own brand'; ok := n = 1 and exists (select 1 from public.clients where id = c_x); detail := n || ' visible'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  select count(*) into n from public.profiles;
  test := 'contact cannot list the Kaizen team'; ok := n = 0; detail := n || ' rows'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  select count(*) into n from public.client_assignments;
  test := 'contact cannot see team assignments'; ok := n = 0; detail := n || ' rows'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  select count(*) into n from public.settings;
  test := 'contact cannot read internal settings'; ok := n = 0; detail := n || ' rows'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  begin
    insert into public.angles (client_id, name) values (c_x, 'Contact angle');
    test := 'contact cannot add angles'; ok := false; detail := 'insert succeeded'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  exception when others then
    test := 'contact cannot add angles'; ok := true; detail := sqlerrm; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  end;
  begin
    update public.clients set name = 'Hacked' where id = c_x;
    get diagnostics n = row_count;
    test := 'contact cannot edit the client'; ok := n = 0; detail := n || ' rows updated'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  end;

  -- Assigned buyer
  perform pg_temp.act_as(a_buyer);
  select count(*) into n from public.clients where id in (c_x, c_y);
  test := 'buyer sees only assigned clients'; ok := n = 1; detail := n || ' visible'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  insert into public.angles (client_id, name) values (c_x, 'Weekly Deals');
  test := 'buyer can add an angle to their client'; ok := true; detail := ''; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  begin
    insert into public.angles (client_id, name) values (c_y, 'Not mine');
    test := 'buyer cannot add an angle to another client'; ok := false; detail := 'insert succeeded'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  exception when others then
    test := 'buyer cannot add an angle to another client'; ok := true; detail := sqlerrm; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  end;
  begin
    update public.profiles set role = 'executive' where id = p_buyer;
    get diagnostics n = row_count;
    test := 'buyer cannot make themselves an exec'; ok := n = 0; detail := n || ' rows updated'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  end;

  begin
    insert into public.client_assignments (client_id, profile_id, role) values (c_y, p_buyer, 'meta_buyer');
    test := 'buyer cannot assign themselves to another client'; ok := false; detail := 'insert succeeded'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  exception when others then
    test := 'buyer cannot assign themselves to another client'; ok := true; detail := sqlerrm; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  end;

  -- Coordinator (Jorgi) and exec see everything
  perform pg_temp.act_as(a_coord);
  select count(*) into n from public.clients where id in (c_x, c_y);
  test := 'coordinator sees every client'; ok := n = 2; detail := n || ' visible'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  select count(*) into n from public.contacts where id = k_id;
  test := 'coordinator sees client contacts'; ok := n = 1; detail := n || ' visible'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);

  perform pg_temp.act_as(a_exec);
  select count(*) into n from public.clients where id in (c_x, c_y);
  test := 'exec sees every client'; ok := n = 2; detail := n || ' visible'; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);
  update public.clients set slack_channel_id = 'C123' where id = c_x;
  get diagnostics n = row_count;
  test := 'exec can edit a client'; ok := n = 1; detail := ''; results := results || jsonb_build_object('test', test, 'ok', ok, 'detail', detail);

  perform pg_temp.act_as(null);
  raise exception 'rollback fixtures';
 exception when others then
  if sqlerrm <> 'rollback fixtures' then
    results := results || jsonb_build_object('test', 'tests ran to the end', 'ok', false, 'detail', sqlerrm);
  end if;
 end;
 return query select r.test, r.ok, r.detail from jsonb_to_recordset(results) as r(test text, ok boolean, detail text);
end $$;

select * from pg_temp.run();
