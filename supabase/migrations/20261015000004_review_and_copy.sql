-- Kaizen Ads — internal creative review and the copy stage
-- Review: comments pinned to a spot on an image or a moment in a video, per design version. Jesus (or an exec)
-- approves the creative, which moves the ticket to Copy, or sends it back to production with the open comments.
-- Copy: one copy set per ticket in Kyle's format (3 short + 2 long). The Copywriter drafts it, Camille edits and
-- approves it, and the AI's draft is kept next to her final version so later drafts learn from her edits.

-- ─── Review comments ────────────────────────────────────────────────────────

create table public.review_comments (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.requests(id) on delete cascade,
  client_id    uuid not null references public.clients(id) on delete cascade,
  design_id    uuid not null references public.designs(id) on delete cascade,
  version      int not null,
  file_id      uuid references public.design_files(id) on delete set null,
  x            numeric check (x between 0 and 1),   -- pin position on an image, 0-1 from the left
  y            numeric check (y between 0 and 1),
  t_ms         int check (t_ms >= 0),               -- moment in a video
  body         text not null check (length(trim(body)) between 1 and 2000),
  round        text not null default 'internal' check (round in ('internal', 'client')),
  author_id    uuid references public.profiles(id) on delete set null,
  remembered   boolean not null default false,       -- also saved to client memory
  resolved_at  timestamptz,
  resolved_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index on public.review_comments (request_id, created_at);
create index on public.review_comments (design_id);
alter table public.review_comments enable row level security;
create policy "staff read review comments" on public.review_comments for select to authenticated
  using (private.staff_can_see_client(client_id));
create policy "staff add review comments" on public.review_comments for insert to authenticated
  with check (private.staff_can_see_client(client_id) and author_id = private.current_profile_id());
create policy "staff resolve review comments" on public.review_comments for update to authenticated
  using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));

alter table public.request_events drop constraint request_events_kind_check;
alter table public.request_events add constraint request_events_kind_check
  check (kind in ('created', 'stage', 'assign', 'due', 'priority', 'comment', 'upload', 'review', 'copy'));

-- Jesus (head of creative) or an exec decides. Approve → Copy. Changes → back to production with the note.
create function public.review_creative(p_request uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r      public.requests := private.assert_can_work(p_request);
  v_me   uuid := private.current_profile_id();
  v_to   public.request_stage;
  v_now  timestamptz := now();
  v_open int;
begin
  if not private.is_exec_or_lead() then raise exception 'Only the head of creative or an exec can review creative'; end if;
  if r.stage <> 'internal_review' then raise exception 'This ticket isn''t waiting for creative review'; end if;
  if p_decision not in ('approve', 'changes') then raise exception 'Unknown decision'; end if;
  if not exists (select 1 from public.designs where request_id = p_request) then raise exception 'Nothing has been uploaded yet'; end if;
  select count(*) into v_open from public.review_comments where request_id = p_request and resolved_at is null and round = 'internal';
  if p_decision = 'changes' and v_open = 0 and nullif(trim(p_note), '') is null then
    raise exception 'Say what needs to change: pin a comment or add a note';
  end if;

  v_to := case when p_decision = 'approve' then 'copy' else 'in_production' end;
  update public.requests
  set stage = v_to,
      stage_entered_at = v_now,
      stage_due_at = private.stage_due(v_to, r.format, r.priority, v_now, r.created_at),
      assignee_id = coalesce(private.stage_owner(r, v_to), r.assignee_id)
  where id = p_request;
  -- Approving closes this round's comments
  if p_decision = 'approve' then
    update public.review_comments set resolved_at = v_now, resolved_by = v_me
    where request_id = p_request and resolved_at is null and round = 'internal';
  end if;
  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, body, data)
  values (p_request, 'review', r.stage, v_to, v_me, nullif(trim(p_note), ''),
          jsonb_build_object('decision', p_decision, 'open_comments', v_open));
end $$;
revoke execute on function public.review_creative(uuid, text, text) from public, anon;
grant execute on function public.review_creative(uuid, text, text) to authenticated;

-- ─── Copy sets ──────────────────────────────────────────────────────────────

create table public.copy_sets (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null unique references public.requests(id) on delete cascade,
  client_id    uuid not null references public.clients(id) on delete cascade,
  angle_id     uuid references public.angles(id) on delete set null,
  status       text not null default 'drafting' check (status in ('drafting', 'review', 'approved', 'failed')),
  ads          jsonb not null default '[]',   -- what Camille sees and edits
  ai_ads       jsonb not null default '[]',   -- the AI's draft, kept to learn from her edits
  notes        text,                          -- the copywriter agent's notes for Camille
  model        text,
  error        text,
  reused_from  uuid references public.copy_sets(id) on delete set null,
  version      int not null default 1,
  updated_by   uuid references public.profiles(id) on delete set null,
  approved_by  uuid references public.profiles(id) on delete set null,
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.copy_sets (client_id, angle_id, status);
alter table public.copy_sets enable row level security;
create policy "staff read copy" on public.copy_sets for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff edit copy" on public.copy_sets for update to authenticated
  using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));
-- Drafts are created by the server after the AI call

-- Camille (copywriter) or an exec/lead approves; the ticket moves to Ready for client
create function public.approve_copy(p_set uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s     public.copy_sets;
  r     public.requests;
  v_me  uuid := private.current_profile_id();
  v_now timestamptz := now();
begin
  select * into s from public.copy_sets where id = p_set;
  if s.id is null then raise exception 'Copy not found'; end if;
  r := private.assert_can_work(s.request_id);
  if not (private.is_exec_or_lead() or exists (select 1 from public.profiles where id = v_me and role = 'copywriter')) then
    raise exception 'Only Camille or a lead can approve copy';
  end if;
  if jsonb_array_length(s.ads) = 0 then raise exception 'There''s no copy to approve'; end if;
  update public.copy_sets set status = 'approved', approved_by = v_me, approved_at = v_now, updated_at = v_now where id = p_set;
  if r.stage in ('copy', 'copy_review') then
    update public.requests
    set stage = 'ready_for_client', stage_entered_at = v_now,
        stage_due_at = private.stage_due('ready_for_client', r.format, r.priority, v_now, r.created_at),
        assignee_id = coalesce(private.stage_owner(r, 'ready_for_client'), r.assignee_id)
    where id = r.id;
  end if;
  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, data)
  values (r.id, 'copy', r.stage, case when r.stage in ('copy', 'copy_review') then 'ready_for_client'::public.request_stage else r.stage end, v_me,
          jsonb_build_object('action', case when s.reused_from is not null then 'reused' else 'approved' end));
end $$;
revoke execute on function public.approve_copy(uuid) from public, anon;
grant execute on function public.approve_copy(uuid) to authenticated;
