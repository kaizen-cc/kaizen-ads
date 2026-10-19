-- Notifications: what's new for each person, made where it happens (triggers), so no code path can forget one.
-- Only people who have joined (signed in at least once) and are active get them, and never for something they did
-- themselves. Each has a key so the same thing never notifies twice. Critical ones are also emailed if they're still
-- unread a few minutes later (the "notify" cron step).
--   On you:         a ticket assigned to you, made the buyer on one, put on a client, an Asana task assigned to you,
--                   a handoff ready for you
--   Your work:      a ticket you're on moves, gets a comment, a review or new copy
--   Your clients:   a promise made on a call, an ad worn out, an account going off target, a sprint check
--   Execs & leads:  a new client starting, a first round ready, an important account going off target
--   Reminders:      your daily recap, if you haven't been through it (the "remind" cron step)

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text,
  href        text,
  client_id   uuid references public.clients (id) on delete cascade,
  key         text not null,
  priority    text not null default 'normal' check (priority in ('critical', 'normal')),
  actor_id    uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  emailed_at  timestamptz,
  unique (profile_id, key)
);
create index on public.notifications (profile_id, created_at desc);
create index on public.notifications (profile_id) where read_at is null;
alter table public.notifications enable row level security;
create policy "own notifications" on public.notifications for select to authenticated using (profile_id = private.current_profile_id());
create policy "read own notifications" on public.notifications for update to authenticated using (profile_id = private.current_profile_id()) with check (profile_id = private.current_profile_id());

-- When someone last went through their daily recap (for the reminder)
alter table public.profiles add column recap_seen_on date;

-- One notification, if the person has joined, is active, and isn't the one who did it
create function private.notify(p_profile uuid, p_kind text, p_title text, p_body text, p_href text, p_client uuid, p_key text, p_priority text default 'normal')
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.current_profile_id();
begin
  if p_profile is null or p_profile = v_actor then return; end if;
  if not exists (select 1 from public.profiles where id = p_profile and is_active and joined_at is not null) then return; end if;
  insert into public.notifications (profile_id, kind, title, body, href, client_id, key, priority, actor_id)
  values (p_profile, p_kind, left(p_title, 300), left(p_body, 1000), p_href, p_client, p_key, p_priority, v_actor)
  on conflict (profile_id, key) do nothing;
end $$;

-- The people on a client: its assigned team and whoever owns its KPI targets
create function private.client_people(p_client uuid) returns setof uuid language sql stable security definer set search_path = '' as $$
  select profile_id from public.client_assignments where client_id = p_client
  union select owner_id from public.kpi_targets where client_id = p_client and active and owner_id is not null
$$;
-- The client's buyers only (Meta and Google, and KPI owners)
create function private.client_buyers(p_client uuid) returns setof uuid language sql stable security definer set search_path = '' as $$
  select profile_id from public.client_assignments where client_id = p_client and role in ('meta_buyer', 'google_buyer')
  union select owner_id from public.kpi_targets where client_id = p_client and active and owner_id is not null
$$;
create function private.managers() returns setof uuid language sql stable security definer set search_path = '' as $$
  select id from public.profiles where (is_exec or is_lead) and is_active and joined_at is not null
$$;

create function private.stage_label(p text) returns text language sql immutable as $$
  select case p
    when 'requested' then 'Requested' when 'in_production' then 'In production' when 'internal_review' then 'Creative review'
    when 'copy' then 'Copy' when 'copy_review' then 'Copy review' when 'client_review' then 'With the client'
    when 'client_revision' then 'Client changes' when 'ready_for_launch' then 'Ready to launch' when 'launched' then 'Launched'
    else initcap(replace(p, '_', ' ')) end
$$;

-- ─── Tickets ───────────────────────────────────────────────────────────────
create function private.notify_request() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_client text;
begin
  select name into v_client from public.clients where id = new.client_id;
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id or new.stage is distinct from old.stage) then
    perform private.notify(new.assignee_id, 'assigned', format('#%s is on you: %s', new.number, new.title), format('%s · %s', v_client, private.stage_label(new.stage::text)),
      format('/board?t=%s', new.number), new.client_id, format('assign:%s:%s:%s', new.id, new.assignee_id, new.stage), 'normal');
  end if;
  if new.buyer_id is not null and (tg_op = 'INSERT' or new.buyer_id is distinct from old.buyer_id) then
    perform private.notify(new.buyer_id, 'assigned', format('You''re the buyer on #%s: %s', new.number, new.title), v_client,
      format('/board?t=%s', new.number), new.client_id, format('buyer:%s:%s', new.id, new.buyer_id), 'normal');
  end if;
  return new;
end $$;
create trigger notify_request after insert or update of assignee_id, buyer_id, stage on public.requests for each row execute function private.notify_request();

create function private.notify_request_event() returns trigger language plpgsql security definer set search_path = '' as $$
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
    v_title := format('%s commented on #%s', coalesce(v_actor, 'Someone'), r.number);
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
create trigger notify_request_event after insert on public.request_events for each row execute function private.notify_request_event();

-- ─── Being put on things ───────────────────────────────────────────────────
create function private.notify_assignment() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_client text; v_slug text;
begin
  select name, slug into v_client, v_slug from public.clients where id = new.client_id;
  perform private.notify(new.profile_id, 'client', format('You''re on %s', v_client), format('As the %s', replace(new.role::text, '_', ' ')),
    format('/clients/%s', v_slug), new.client_id, format('ca:%s:%s:%s', new.client_id, new.role, new.profile_id), 'normal');
  return new;
end $$;
create trigger notify_assignment after insert on public.client_assignments for each row execute function private.notify_assignment();

create function private.notify_asana() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is not null and new.open and (tg_op = 'INSERT' or new.profile_id is distinct from old.profile_id) then
    perform private.notify(new.profile_id, 'assigned', format('Asana task on you: %s', new.name), coalesce(new.section, ''), new.url, new.client_id, format('asana:%s:%s', new.gid, new.profile_id), 'normal');
  end if;
  return new;
end $$;
create trigger notify_asana after insert or update of profile_id on public.asana_tasks for each row execute function private.notify_asana();

create function private.notify_handoff() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_client text;
begin
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    select name into v_client from public.clients where id = new.client_id;
    perform private.notify(new.to_id, 'handoff', format('%s is yours: your handoff is ready', v_client), 'Everything about the account up to now, and a chat to ask about it.',
      format('/handoff/%s', new.id), new.client_id, format('handoff:%s', new.id), 'critical');
  end if;
  return new;
end $$;
create trigger notify_handoff after insert or update of status on public.account_handoffs for each row execute function private.notify_handoff();

-- ─── What happens on your clients ──────────────────────────────────────────
create function private.notify_promise() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_client text; v_slug text; p uuid;
begin
  select name, slug into v_client, v_slug from public.clients where id = new.client_id;
  for p in select * from private.client_buyers(new.client_id) union select * from private.managers() loop
    perform private.notify(p, 'promise', format('Promised on a call with %s', v_client), new.what, format('/clients/%s', v_slug), new.client_id, format('promise:%s', new.id), 'normal');
  end loop;
  return new;
end $$;
create trigger notify_promise after insert on public.call_commitments for each row execute function private.notify_promise();

create function private.notify_fatigue() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_client text; v_slug text; p uuid;
begin
  if new.severity::text = 'tired' and new.state::text = 'open' and (tg_op = 'INSERT' or old.severity::text is distinct from 'tired') then
    select name, slug into v_client, v_slug from public.clients where id = new.client_id;
    for p in select * from private.client_buyers(new.client_id) loop
      perform private.notify(p, 'fatigue', format('An ad is worn out on %s', v_client), coalesce(new.headline, new.ad_name), format('/clients/%s', v_slug), new.client_id, format('tired:%s:%s:%s', new.client_id, new.ad_id, to_char(now(), 'YYYY-MM')), 'normal');
    end loop;
  end if;
  return new;
end $$;
create trigger notify_fatigue after insert or update of severity on public.ad_fatigue for each row execute function private.notify_fatigue();

create function private.notify_kpi() returns trigger language plpgsql security definer set search_path = '' as $$
declare t public.kpi_targets; v_client text; v_slug text; v_high boolean; p uuid;
begin
  if new.status::text = 'off' and (tg_op = 'INSERT' or old.status::text is distinct from 'off') then
    select * into t from public.kpi_targets where id = new.target_id;
    if t.id is null or not t.active then return new; end if;
    select name, slug into v_client, v_slug from public.clients where id = t.client_id;
    v_high := lower(coalesce(t.sheet->>'priority', '')) = 'high';
    perform private.notify(t.owner_id, 'kpi', format('%s went off target', v_client), format('%s%% off its KPI target. Worth a look before it slides further.', round(coalesce(new.deviation, 0) * 100)),
      format('/kpis?client=%s', v_slug), t.client_id, format('off:%s:%s', t.id, to_char(now(), 'YYYY-MM-DD')), case when v_high then 'critical' else 'normal' end);
    if v_high then
      for p in select * from private.managers() loop
        perform private.notify(p, 'kpi', format('%s (high priority) went off target', v_client), format('%s%% off its KPI target.', round(coalesce(new.deviation, 0) * 100)),
          format('/kpis?client=%s', v_slug), t.client_id, format('off:%s:%s', t.id, to_char(now(), 'YYYY-MM-DD')), 'critical');
      end loop;
    end if;
  end if;
  return new;
end $$;
create trigger notify_kpi after insert or update of status on public.kpi_snapshots for each row execute function private.notify_kpi();

create function private.notify_sprint_check() returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.optimization_sprints; v_client text;
begin
  select * into s from public.optimization_sprints where id = new.sprint_id;
  if s.id is null then return new; end if;
  select name into v_client from public.clients where id = s.client_id;
  perform private.notify(s.buyer_id, 'sprint', format('Sprint check-in on %s', v_client), 'The AI looked at what changed since the last check. Open the sprint for its notes.',
    format('/kpis/sprint/%s', s.id), s.client_id, format('check:%s', new.id), 'normal');
  return new;
end $$;
create trigger notify_sprint_check after insert on public.sprint_checks for each row execute function private.notify_sprint_check();

-- ─── For execs and leads ───────────────────────────────────────────────────
create function private.notify_first_round() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_client text; p uuid;
begin
  if new.kind::text = 'onboarding' and new.status::text = 'open' then
    select name into v_client from public.clients where id = new.client_id;
    for p in select * from private.managers() loop
      perform private.notify(p, 'onboarding', format('%s''s first round is ready', v_client), 'Their first creative is written and waiting for your review.', '/pipeline', new.client_id, format('round:%s', new.id), 'critical');
    end loop;
  end if;
  return new;
end $$;
create trigger notify_first_round after insert on public.creative_suggestions for each row execute function private.notify_first_round();

create function private.notify_new_client() returns trigger language plpgsql security definer set search_path = '' as $$
declare p uuid;
begin
  if new.status::text = 'onboarding' and (tg_op = 'INSERT' or old.status::text is distinct from 'onboarding') then
    for p in select * from private.managers() union select id from public.profiles where is_coordinator and is_active and joined_at is not null loop
      perform private.notify(p, 'client', format('New client: %s', new.name), 'Onboarding has started.', format('/clients/%s', new.slug), new.id, format('newclient:%s:%s', new.id, to_char(now(), 'YYYY-MM-DD')), 'normal');
    end loop;
  end if;
  return new;
end $$;
create trigger notify_new_client after insert or update of status on public.clients for each row execute function private.notify_new_client();
