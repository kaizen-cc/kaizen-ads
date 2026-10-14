-- Tickets: create, auto-assign, turnaround, move, reassign, board timing, who can see them.
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
  a_buyer uuid; a_other uuid; a_contact uuid; k_id uuid;
  t uuid; v uuid; r public.requests; n int;
  results jsonb := '[]';
begin
 begin
  insert into public.clients (name, slug) values ('ZZ Ticket Client', 'zz-ticket-x') returning id into c_x;
  insert into public.clients (name, slug) values ('ZZ Other Client', 'zz-ticket-y') returning id into c_y;
  insert into public.profiles (email, full_name, role) values ('zz-tb@kaizenmarketing.agency', 'ZZ Buyer', 'media_buyer') returning id into p_buyer;
  insert into public.profiles (email, full_name, role) values ('zz-td@kaizenmarketing.agency', 'ZZ Designer', 'graphic_designer') returning id into p_designer;
  insert into public.profiles (email, full_name, role) values ('zz-te@kaizenmarketing.agency', 'ZZ Editor', 'video_editor') returning id into p_editor;
  insert into public.profiles (email, full_name, role) values ('zz-to@kaizenmarketing.agency', 'ZZ Other', 'media_buyer') returning id into p_other;
  insert into public.client_assignments (client_id, profile_id, role) values
    (c_x, p_buyer, 'meta_buyer'), (c_x, p_designer, 'graphic_designer'), (c_x, p_editor, 'video_editor'), (c_y, p_other, 'meta_buyer');
  insert into public.contacts (email) values ('zz-tc@example.com') returning id into k_id;
  insert into public.contact_clients (contact_id, client_id) values (k_id, c_x);
  a_buyer := pg_temp.new_auth('zz-tb@kaizenmarketing.agency');
  a_other := pg_temp.new_auth('zz-to@kaizenmarketing.agency');
  a_contact := pg_temp.new_auth('zz-tc@example.com');

  perform pg_temp.act_as(a_buyer);
  t := public.create_request(c_x, 'Calzone Mondays', 'image', 'new', 'normal', 'Weekly Deals', 'Families', 'Make it pop', '{}', '{1x1,4x5}', 3);
  v := public.create_request(c_x, 'Founder story', 'video');
  select * into r from public.requests where id = t;

  results := results || jsonb_build_object('test', 'image request goes to the client''s designer', 'ok', r.assignee_id = p_designer and r.creative_id = p_designer, 'detail', '');
  results := results || jsonb_build_object('test', 'video request goes to the client''s editor',
    'ok', (select assignee_id from public.requests where id = v) = p_editor, 'detail', '');
  results := results || jsonb_build_object('test', 'buyer is the client''s Meta buyer', 'ok', r.buyer_id = p_buyer, 'detail', '');
  results := results || jsonb_build_object('test', 'image turnaround is 2 business days',
    'ok', r.stage_due_at = public.add_business_days(r.created_at, 2), 'detail', r.stage_due_at::text);
  results := results || jsonb_build_object('test', 'video turnaround is 4 business days',
    'ok', (select stage_due_at = public.add_business_days(created_at, 4) from public.requests where id = v), 'detail', '');
  results := results || jsonb_build_object('test', 'angle created from the request',
    'ok', exists (select 1 from public.angles where client_id = c_x and name = 'Weekly Deals'), 'detail', '');
  results := results || jsonb_build_object('test', 'ticket numbers start at 1001 or above', 'ok', r.number >= 1001, 'detail', r.number::text);

  perform public.move_request(t, 'internal_review', 'Ready for Jesus');
  select * into r from public.requests where id = t;
  results := results || jsonb_build_object('test', 'moving to internal review starts a 1-day clock',
    'ok', r.stage = 'internal_review' and r.stage_due_at = public.add_business_days(r.stage_entered_at, 1), 'detail', '');
  perform public.move_request(t, 'ready_for_launch');
  select * into r from public.requests where id = t;
  results := results || jsonb_build_object('test', 'ready for launch goes back to the buyer', 'ok', r.assignee_id = p_buyer, 'detail', '');

  perform public.assign_request(t, p_designer);
  perform public.set_request_priority(t, 'urgent');
  perform public.comment_request(t, 'Looks great');
  select count(*) into n from public.request_events where request_id = t;
  results := results || jsonb_build_object('test', 'every change is logged', 'ok', n = 6, 'detail', n || ' events');

  select count(*) into n from public.board_requests where id in (t, v) and minutes_in_stage >= 0 and minutes_over >= 0;
  results := results || jsonb_build_object('test', 'board shows timing for each ticket', 'ok', n = 2, 'detail', n || ' rows');

  begin
    perform public.create_request(c_y, 'Not my client', 'image');
    results := results || jsonb_build_object('test', 'cannot request for a client you are not on', 'ok', false, 'detail', 'created');
  exception when others then
    results := results || jsonb_build_object('test', 'cannot request for a client you are not on', 'ok', true, 'detail', sqlerrm);
  end;
  begin
    update public.requests set stage = 'launched' where id = t;
    get diagnostics n = row_count;
    results := results || jsonb_build_object('test', 'tickets only change through the checked functions', 'ok', n = 0, 'detail', n || ' rows');
  end;

  perform pg_temp.act_as(a_other);
  select count(*) into n from public.board_requests where id in (t, v);
  results := results || jsonb_build_object('test', 'buyers on other clients cannot see these tickets', 'ok', n = 0, 'detail', n || ' visible');
  begin
    perform public.move_request(t, 'launched');
    results := results || jsonb_build_object('test', 'cannot move another client''s ticket', 'ok', false, 'detail', 'moved');
  exception when others then
    results := results || jsonb_build_object('test', 'cannot move another client''s ticket', 'ok', true, 'detail', sqlerrm);
  end;

  perform pg_temp.act_as(a_contact);
  select count(*) into n from public.requests where id in (t, v);
  results := results || jsonb_build_object('test', 'client contacts cannot see internal tickets', 'ok', n = 0, 'detail', n || ' visible');

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
