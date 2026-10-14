-- Kaizen Ads — sprint (temporary) creative packages
-- The enrollment and upsell forms give a client a regular package (no end date). Only an exec can override:
-- a sprint package always has an end date, after which creative requests stop and the package switches off.

alter table public.clients
  add column creative_package_until date,               -- set = sprint package, ends after this day (New York)
  add column creative_package_note text,
  add column creative_package_set_by uuid references public.profiles(id) on delete set null,
  add column creative_package_set_at timestamptz;

create function private.ny_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/New_York')::date
$$;

-- A package counts while it's on and (for a sprint) its end date hasn't passed
create or replace function private.assert_creative_package(p_client uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.clients
    where id = p_client and creative_package and (creative_package_until is null or creative_package_until >= private.ny_today())
  ) then
    raise exception 'This client isn''t on a creative package';
  end if;
end $$;

-- Switch off sprints whose end date has passed (run by the scheduled jobs)
create function public.expire_sprint_packages() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.clients
  set creative_package = false
  where creative_package and creative_package_until is not null and creative_package_until < private.ny_today();
  get diagnostics n = row_count;
  return n;
end $$;

-- Execs only: give a client a sprint package until a date, change it, or end it
create function public.set_sprint_package(
  p_client uuid, p_until date, p_package text default null, p_images int default null, p_videos int default null, p_note text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_pkg public.creative_packages;
begin
  if not private.is_exec() then raise exception 'Only an exec can override a client''s creative package'; end if;
  if p_until is null or p_until < private.ny_today() then raise exception 'Pick an end date from today on'; end if;
  if p_package is not null then
    select * into v_pkg from public.creative_packages where key = p_package;
    if v_pkg.key is null then raise exception 'Unknown package'; end if;
  end if;
  update public.clients
  set creative_package = true,
      creative_package_until = p_until,
      creative_package_key = coalesce(v_pkg.key, creative_package_key),
      creative_package_note = nullif(trim(p_note), ''),
      creative_package_set_by = private.current_profile_id(),
      creative_package_set_at = now()
  where id = p_client;
  insert into public.client_allotments (client_id, images_per_month, videos_per_month, updated_by, updated_at)
  values (p_client, greatest(coalesce(p_images, v_pkg.images, 0), 0), greatest(coalesce(p_videos, v_pkg.videos, 0), 0), private.current_profile_id(), now())
  on conflict (client_id) do update
  set images_per_month = excluded.images_per_month, videos_per_month = excluded.videos_per_month, updated_by = excluded.updated_by, updated_at = now();
end $$;

create function public.end_creative_package(p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_exec() then raise exception 'Only an exec can end a client''s creative package'; end if;
  update public.clients
  set creative_package = false, creative_package_until = null, creative_package_note = null,
      creative_package_set_by = private.current_profile_id(), creative_package_set_at = now()
  where id = p_client;
end $$;

revoke execute on function public.set_sprint_package(uuid, date, text, int, int, text) from public, anon;
revoke execute on function public.end_creative_package(uuid) from public, anon;
revoke execute on function public.expire_sprint_packages() from public, anon, authenticated;
grant execute on function public.set_sprint_package(uuid, date, text, int, int, text) to authenticated;
grant execute on function public.end_creative_package(uuid) to authenticated;
grant execute on function public.expire_sprint_packages() to service_role;
grant execute on function private.ny_today() to authenticated;


-- ─── Enrollment and upsell forms give an ongoing package (clears a sprint) ──
create or replace function public.zapier_enroll(p_key text, p_source text, p_data jsonb) returns jsonb
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
    -- A signed package is ongoing: it replaces any sprint an exec set
    update public.clients set creative_package = true, creative_package_key = coalesce(v_pkg.key, creative_package_key),
      creative_package_until = null, creative_package_note = null where id = v_client;
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

-- ─── Allotments: leads adjust them only for clients on a package; execs always ──
drop policy "execs leads set allotment" on public.client_allotments;
create policy "execs leads set allotment" on public.client_allotments for all to authenticated
  using (private.is_exec() or (private.is_exec_or_lead() and exists (select 1 from public.clients c where c.id = client_id and c.creative_package)))
  with check (private.is_exec() or (private.is_exec_or_lead() and exists (select 1 from public.clients c where c.id = client_id and c.creative_package)));

-- ─── This month's allotment use, now with the sprint end date ──────────────
drop view public.client_allotment_usage;
create view public.client_allotment_usage with (security_invoker = on) as
with month as (
  select (date_trunc('month', now() at time zone 'America/New_York') at time zone 'America/New_York') as starts
)
select c.id as client_id,
  a.images_per_month,
  a.videos_per_month,
  coalesce(sum(r.new_count) filter (where r.format in ('image', 'carousel')), 0)::int as images_used,
  coalesce(sum(r.new_count) filter (where r.format = 'video'), 0)::int as videos_used,
  c.creative_package_until as package_until
from public.clients c
left join public.client_allotments a on a.client_id = c.id
left join public.requests r on r.client_id = c.id and r.created_at >= (select starts from month)
where c.creative_package
  and (c.creative_package_until is null or c.creative_package_until >= (now() at time zone 'America/New_York')::date)
group by c.id, a.images_per_month, a.videos_per_month, c.creative_package_until;

grant select on public.client_allotment_usage to authenticated;
