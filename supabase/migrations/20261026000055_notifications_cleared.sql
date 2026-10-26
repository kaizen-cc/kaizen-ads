-- Clearing notifications: a cleared one leaves the bell but stays on record (cleared_at), so nothing is lost
alter table public.notifications add column if not exists cleared_at timestamptz;
create index if not exists notifications_open on public.notifications (profile_id, created_at desc) where cleared_at is null;

-- Comments Kaizen Ads leaves itself (no person) read "Kaizen Ads commented", not "Someone"
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
  for p in select distinct x from unnest(array[r.assignee_id, r.buyer_id, r.creative_id, r.requested_by]) x where x is not null loop
    perform private.notify(p, 'ticket', v_title, v_body, format('/board?t=%s', r.number), r.client_id, format('ev:%s', new.id), v_priority);
  end loop;
  return new;
end $$;

update public.notifications n set title = regexp_replace(n.title, '^Someone commented', 'Kaizen Ads commented')
where n.title like 'Someone commented on #%' and n.actor_id is null;
