-- Kaizen Ads — clients and Slack channels arrive from Zapier, the same way Kaizen Track gets them
-- The enrollment and upsell forms turn on a client's creative package (and its allotment);
-- the channel-creation Zap links new Slack channels to their client.

-- Same packages as Kaizen Track
create table public.creative_packages (
  key        text primary key,
  label      text not null,
  images     int not null,
  videos     int not null,
  note       text,
  sort_order int not null
);
insert into public.creative_packages (key, label, images, videos, note, sort_order) values
  ('mvp', 'MVP', 3, 0, 'Up to 3 creatives a month; split images and videos on the client page', 1),
  ('basic', 'Basic', 10, 3, null, 2),
  ('silver', 'Silver', 25, 5, null, 3),
  ('gold', 'Gold', 50, 10, null, 4);
alter table public.creative_packages enable row level security;
create policy "staff read packages" on public.creative_packages for select to authenticated using (private.is_staff());

alter table public.clients add column creative_package_key text references public.creative_packages(key);

-- Every Zapier delivery once: retries return the first result
create table public.integration_events (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,
  idempotency_key text not null unique,
  payload         jsonb not null,
  status          text not null default 'received' check (status in ('received', 'processed', 'failed')),
  error           text,
  created_at      timestamptz not null default now(),
  processed_at    timestamptz
);
alter table public.integration_events enable row level security;
create policy "execs read integration events" on public.integration_events for select to authenticated using (private.is_exec());

/** "Silver Package", "silver", "SILVER (25 images…)" → silver */
create function private.creative_package_key(p_text text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_text ~* 'gold' then 'gold'
    when p_text ~* 'silver' then 'silver'
    when p_text ~* 'basic' then 'basic'
    when p_text ~* 'mvp' then 'mvp'
  end
$$;

create function private.unique_slug(p_name text) returns text
language plpgsql set search_path = '' as $$
declare
  base text := trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'));
  s    text := base;
  n    int := 1;
begin
  if base = '' then base := 'client'; s := base; end if;
  while exists (select 1 from public.clients where slug = s) loop
    n := n + 1;
    s := base || '-' || n;
  end loop;
  return s;
end $$;

-- p_data: business_name, client_id (Account Overview ID), creatives (bool), creative_package, client_type, website
create function public.zapier_enroll(p_key text, p_source text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_event   uuid;
  v_prev    jsonb;
  v_name    text := nullif(trim(regexp_replace(coalesce(p_data->>'business_name', ''), '\s+', ' ', 'g')), '');
  v_ext     int := case when coalesce(p_data->>'client_id', '') ~ '^\s*\d+\s*$' then trim(p_data->>'client_id')::int end;
  v_client  uuid;
  v_how     text;
  v_created boolean := false;
  v_pkg     public.creative_packages;
  v_result  jsonb;
  v_white   boolean := coalesce(p_data->>'client_type', '') ~* 'white';
begin
  if p_source not in ('enrollment', 'upsell') then raise exception 'Unknown source'; end if;

  select payload->'result' into v_prev from public.integration_events where idempotency_key = p_key;
  if v_prev is not null then return v_prev || jsonb_build_object('duplicate', true); end if;
  insert into public.integration_events (source, idempotency_key, payload)
  values ('zapier-' || p_source, p_key, jsonb_build_object('data', p_data))
  on conflict (idempotency_key) do nothing
  returning id into v_event;
  if v_event is null then return jsonb_build_object('duplicate', true); end if;

  -- Which client? Their Client ID first, then the name ignoring case, spaces and punctuation
  if v_ext is not null then
    select id into v_client from public.clients where kaizen_id = v_ext;
    v_how := 'client id';
  end if;
  if v_client is null and v_name is not null then
    select id into v_client from public.clients
    where regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(v_name), '[^a-z0-9]', '', 'g')
    order by status = 'active' desc limit 1;
    v_how := 'name';
    if v_client is not null and v_ext is not null and not exists (select 1 from public.clients where kaizen_id = v_ext) then
      update public.clients set kaizen_id = coalesce(kaizen_id, v_ext) where id = v_client;
    end if;
  end if;

  -- An upsell never creates a client: a typo would make a duplicate
  if v_client is null and p_source = 'upsell' then
    update public.integration_events set status = 'failed', error = 'No matching client', processed_at = now() where id = v_event;
    return jsonb_build_object('error', 'No matching client in Kaizen Ads', 'client_id', v_ext, 'client', v_name);
  end if;

  if v_client is null then
    if v_name is null then
      update public.integration_events set status = 'failed', error = 'Business name missing', processed_at = now() where id = v_event;
      return jsonb_build_object('error', 'Business name is missing');
    end if;
    insert into public.clients (name, slug, kaizen_id, status, client_type, website)
    values (v_name, private.unique_slug(v_name), v_ext, 'onboarding', case when v_white then 'whitelabel' else 'traditional' end::public.client_type,
            nullif(trim(p_data->>'website'), ''))
    returning id into v_client;
    v_created := true;
  elsif (select status from public.clients where id = v_client) in ('paused', 'offboarded') then
    update public.clients set status = 'active' where id = v_client;
  end if;

  -- Creative package: turn the client on and set the monthly allotment
  if coalesce((p_data->>'creatives')::boolean, false) or nullif(trim(p_data->>'creative_package'), '') is not null then
    select * into v_pkg from public.creative_packages where key = private.creative_package_key(p_data->>'creative_package');
    update public.clients set creative_package = true, creative_package_key = coalesce(v_pkg.key, creative_package_key) where id = v_client;
    if v_pkg.key = 'mvp' then
      -- MVP is "up to 3 creatives": keep a split the team already set, otherwise start at 3 images
      insert into public.client_allotments (client_id, images_per_month, videos_per_month, updated_at)
      values (v_client, v_pkg.images, v_pkg.videos, now())
      on conflict (client_id) do nothing;
    elsif v_pkg.key is not null then
      insert into public.client_allotments (client_id, images_per_month, videos_per_month, updated_at)
      values (v_client, v_pkg.images, v_pkg.videos, now())
      on conflict (client_id) do update set images_per_month = excluded.images_per_month, videos_per_month = excluded.videos_per_month, updated_at = now();
    end if;
  end if;

  v_result := jsonb_build_object(
    'client_id', v_client, 'client', (select name from public.clients where id = v_client), 'created', v_created,
    'matched_by', case when v_created then null else v_how end,
    'creative_package', v_pkg.key, 'allotment', case when v_pkg.key is not null then v_pkg.images || ' images + ' || v_pkg.videos || ' videos' end,
    'package_not_recognised', case when v_pkg.key is null and nullif(trim(p_data->>'creative_package'), '') is not null then p_data->>'creative_package' end);
  update public.integration_events set status = 'processed', processed_at = now(), payload = payload || jsonb_build_object('result', v_result) where id = v_event;
  return v_result;
end $$;

revoke execute on function public.zapier_enroll(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.zapier_enroll(text, text, jsonb) to service_role; -- only the Zapier route, with the server key
revoke execute on function private.creative_package_key(text) from public, anon;
revoke execute on function private.unique_slug(text) from public, anon, authenticated;

-- Existing clients: record which package their allotment matches
update public.clients c set creative_package_key = p.key
from public.client_allotments a, public.creative_packages p
where a.client_id = c.id and c.creative_package and p.key <> 'mvp' and a.images_per_month = p.images and a.videos_per_month = p.videos;
update public.clients c set creative_package_key = 'mvp'
from public.client_allotments a
where a.client_id = c.id and c.creative_package and c.creative_package_key is null and a.images_per_month + a.videos_per_month <= 4;
