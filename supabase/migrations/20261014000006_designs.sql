-- Kaizen Ads — creative uploads
-- Request → Design (one creative idea) → Version (v1, v2… after changes) → Files (one per size, or per card).
-- Nothing is ever deleted: Replace makes a new version and the old ones stay in the history.
-- Files live in the private "creative" bucket at {client}/{request}/{design}/v{n}/{file}; the path's first
-- folder is the client, which is what storage access is checked against.

create table public.designs (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.requests(id) on delete cascade,
  client_id       uuid not null references public.clients(id) on delete cascade,
  position        int not null,                       -- D1, D2… within the request
  name            text not null check (length(trim(name)) between 1 and 120),
  variation_of    uuid references public.designs(id) on delete set null, -- set = a variation; doesn't count toward the allotment
  is_variation    boolean not null default false,
  current_version int not null default 1,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (request_id, position)
);
create index on public.designs (request_id);

create table public.design_versions (
  id          uuid primary key default gen_random_uuid(),
  design_id   uuid not null references public.designs(id) on delete cascade,
  version     int not null,
  note        text,                                   -- "what changed"
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (design_id, version)
);

create table public.design_files (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references public.design_versions(id) on delete cascade,
  design_id     uuid not null references public.designs(id) on delete cascade,
  path          text not null unique,
  thumb_path    text,
  original_name text not null,
  mime          text not null,
  bytes         bigint not null,
  width         int,
  height        int,
  duration_ms   int,
  aspect        text,                                 -- 1x1, 4x5, 9x16, 16x9, or WxH
  card          int,                                  -- carousel card order
  created_at    timestamptz not null default now()
);
create index on public.design_files (version_id);

alter table public.designs enable row level security;
alter table public.design_versions enable row level security;
alter table public.design_files enable row level security;
create policy "staff read designs" on public.designs for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff read design versions" on public.design_versions for select to authenticated
  using (exists (select 1 from public.designs d where d.id = design_id and private.staff_can_see_client(d.client_id)));
create policy "staff read design files" on public.design_files for select to authenticated
  using (exists (select 1 from public.designs d where d.id = design_id and private.staff_can_see_client(d.client_id)));

alter table public.request_events drop constraint request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('created', 'stage', 'assign', 'due', 'priority', 'comment', 'upload'));

-- ─── Storage ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('creative', 'creative', false, 5368709120)  -- 5 GB per file (the project's own upload limit also applies)
on conflict (id) do nothing;

create function private.path_client(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f-]{36}$' then split_part(p_name, '/', 1)::uuid end
$$;

create policy "staff upload creative" on storage.objects for insert to authenticated
  with check (bucket_id = 'creative' and private.staff_can_see_client(private.path_client(name)));
create policy "staff read creative" on storage.objects for select to authenticated
  using (bucket_id = 'creative' and private.staff_can_see_client(private.path_client(name)));
-- Resumable uploads update the object while chunks arrive
create policy "staff finish creative uploads" on storage.objects for update to authenticated
  using (bucket_id = 'creative' and private.staff_can_see_client(private.path_client(name)))
  with check (bucket_id = 'creative' and private.staff_can_see_client(private.path_client(name)));

-- ─── New designs ───────────────────────────────────────────────────────────
-- p_designs: [{"name": "Calzone pull", "variation_of": null}, …]. Returns the new ids so the browser can upload.
create function public.add_designs(p_request uuid, p_designs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r     public.requests := private.assert_can_work(p_request);
  v_me  uuid := private.current_profile_id();
  v_pos int;
  v_d   jsonb;
  v_id  uuid;
  v_ver uuid;
  v_of  uuid;
  out   jsonb := '[]';
begin
  if jsonb_typeof(p_designs) <> 'array' or jsonb_array_length(p_designs) = 0 then raise exception 'Nothing to upload'; end if;
  select coalesce(max(position), 0) into v_pos from public.designs where request_id = p_request;
  for v_d in select * from jsonb_array_elements(p_designs) loop
    v_pos := v_pos + 1;
    v_of := nullif(v_d->>'variation_of', '')::uuid;
    if v_of is not null and not exists (select 1 from public.designs where id = v_of and request_id = p_request) then
      raise exception 'A variation must be of a design on the same ticket';
    end if;
    insert into public.designs (request_id, client_id, position, name, variation_of, is_variation, created_by)
    values (p_request, r.client_id, v_pos, coalesce(nullif(trim(v_d->>'name'), ''), 'Design ' || v_pos), v_of,
            v_of is not null or coalesce((v_d->>'is_variation')::boolean, false), v_me)
    returning id into v_id;
    insert into public.design_versions (design_id, version, created_by) values (v_id, 1, v_me) returning id into v_ver;
    out := out || jsonb_build_object('design_id', v_id, 'version_id', v_ver, 'version', 1, 'position', v_pos);
  end loop;
  insert into public.request_events (request_id, kind, actor_id, data)
  values (p_request, 'upload', v_me, jsonb_build_object('designs', jsonb_array_length(p_designs)));
  return out;
end $$;

-- Replace: a new version of an existing design
create function public.add_design_version(p_design uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d    public.designs;
  v_me uuid := private.current_profile_id();
  v_n  int;
  v_id uuid;
begin
  select * into d from public.designs where id = p_design;
  if d.id is null then raise exception 'Design not found'; end if;
  perform private.assert_can_work(d.request_id);
  v_n := d.current_version + 1;
  insert into public.design_versions (design_id, version, note, created_by) values (p_design, v_n, nullif(trim(p_note), ''), v_me) returning id into v_id;
  update public.designs set current_version = v_n where id = p_design;
  insert into public.request_events (request_id, kind, actor_id, body, data)
  values (d.request_id, 'upload', v_me, nullif(trim(p_note), ''), jsonb_build_object('design', d.name, 'version', v_n));
  return jsonb_build_object('design_id', p_design, 'version_id', v_id, 'version', v_n);
end $$;

-- After the browser finishes uploading a version's files, record them
create function public.record_design_files(p_version uuid, p_files jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v    public.design_versions;
  d    public.designs;
  f    jsonb;
  pre  text;
begin
  select * into v from public.design_versions where id = p_version;
  if v.id is null then raise exception 'Version not found'; end if;
  select * into d from public.designs where id = v.design_id;
  perform private.assert_can_work(d.request_id);
  pre := d.client_id || '/' || d.request_id || '/' || d.id || '/v' || v.version || '/';
  for f in select * from jsonb_array_elements(p_files) loop
    if left(f->>'path', length(pre)) <> pre or (f->>'thumb_path' is not null and left(f->>'thumb_path', length(pre)) <> pre) then
      raise exception 'File is outside this design''s folder';
    end if;
    insert into public.design_files (version_id, design_id, path, thumb_path, original_name, mime, bytes, width, height, duration_ms, aspect, card)
    values (p_version, d.id, f->>'path', f->>'thumb_path', f->>'original_name', f->>'mime', (f->>'bytes')::bigint,
            (f->>'width')::int, (f->>'height')::int, (f->>'duration_ms')::int, f->>'aspect', (f->>'card')::int)
    on conflict (path) do nothing;
  end loop;
end $$;

revoke execute on function public.add_designs(uuid, jsonb) from public, anon;
revoke execute on function public.add_design_version(uuid, text) from public, anon;
revoke execute on function public.record_design_files(uuid, jsonb) from public, anon;
revoke execute on function private.path_client(text) from public, anon;
grant execute on function public.add_designs(uuid, jsonb) to authenticated;
grant execute on function public.add_design_version(uuid, text) to authenticated;
grant execute on function public.record_design_files(uuid, jsonb) to authenticated;
grant execute on function private.path_client(text) to authenticated;
