-- Kaizen Ads — the client portal and the client revision loop
--
-- Clients swipe through their ads: right approves, left asks for changes (design, copy or both, with notes pinned on
-- the creative or the video timeline). Changes send design back to the maker and copy to the AI to amend, then to copy
-- review; when it goes back to the client it's tagged revised with what they asked and what changed.
--
-- Nothing reaches a client until Kaizen switches their portal live: until then their contacts can't get a sign-in link,
-- the portal shows them nothing, and no notification exists. The team tests the whole loop from the staff preview.

-- ─── Live switch (off for everyone) ─────────────────────────────────────────
alter table public.clients
  add column portal_live     boolean not null default false,
  add column portal_live_at  timestamptz,
  add column portal_live_by  uuid references public.profiles(id) on delete set null;

-- ─── Client comments: written by a contact (or a team member testing as the client) ──
alter table public.review_comments
  add column author_contact_id uuid references public.contacts(id) on delete set null,
  add column author_name       text;  -- shown name, e.g. "Maria (client)" or "Santi Lozano (testing as client)"

-- ─── Rounds: every client decision on a ticket ──────────────────────────────
create table public.client_rounds (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.requests(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  round         int not null,
  decision      text not null check (decision in ('approved', 'revise')),
  targets       text[] not null default '{}' check (targets <@ array['design', 'copy']::text[]),
  copy_notes    text,                         -- what the client wants changed in the copy
  design_note   text,                         -- an overall note on the design (pins are review_comments)
  by_contact    uuid references public.contacts(id) on delete set null,
  by_profile    uuid references public.profiles(id) on delete set null,  -- a team member testing as the client
  by_name       text,
  changes       jsonb,                        -- when it goes back: [{asked, changed}] for the "revised" tag
  sent_back_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (request_id, round)
);
create index on public.client_rounds (client_id, created_at desc);
alter table public.client_rounds enable row level security;
create policy "staff read client rounds" on public.client_rounds for select to authenticated using (private.staff_can_see_client(client_id));

-- ─── Copy revised for the client: amended, not rewritten (unless they reject it) ──
alter table public.copy_sets
  add column client_notes  text,     -- what the client asked for in this round
  add column changes       jsonb,    -- [{ad, what}] what the AI changed for it
  add column scope         text check (scope in ('amend', 'rewrite'));

-- ─── The decision. Called by the server after it checks who's deciding. ──────
create function public.client_decide(
  p_request uuid, p_decision text, p_targets text[], p_copy_notes text, p_design_note text,
  p_by_contact uuid, p_by_profile uuid, p_by_name text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r       public.requests;
  v_round int;
  v_id    uuid;
  v_to    public.request_stage;
  v_now   timestamptz := now();
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Ticket not found'; end if;
  if r.stage <> 'client_review' then raise exception 'This ad isn''t waiting for your review any more'; end if;
  if p_decision not in ('approved', 'revise') then raise exception 'Unknown decision'; end if;
  if p_decision = 'revise' and coalesce(array_length(p_targets, 1), 0) = 0 then raise exception 'Say whether the design or the copy needs changes'; end if;

  select coalesce(max(round), 0) + 1 into v_round from public.client_rounds where request_id = p_request;
  insert into public.client_rounds (request_id, client_id, round, decision, targets, copy_notes, design_note, by_contact, by_profile, by_name)
  values (p_request, r.client_id, v_round, p_decision, case when p_decision = 'revise' then p_targets else '{}' end,
          nullif(trim(p_copy_notes), ''), nullif(trim(p_design_note), ''), p_by_contact, p_by_profile, p_by_name)
  returning id into v_id;

  -- Approved → ready to launch. Design changes → back to the maker. Copy only → the AI amends it (copy, then copy review).
  v_to := case
    when p_decision = 'approved' then 'ready_for_launch'
    when 'design' = any(p_targets) then 'client_revision'
    else 'copy'
  end;
  update public.requests
  set stage = v_to,
      stage_entered_at = v_now,
      stage_due_at = private.stage_due(v_to, r.format, r.priority, v_now, r.created_at),
      assignee_id = case when v_to = 'copy' then null else coalesce(private.stage_owner(r, v_to), r.assignee_id) end
  where id = p_request;
  -- The copy is being amended: copy review approves it again before it goes back
  if 'copy' = any(p_targets) then
    update public.copy_sets set status = 'drafting', client_notes = nullif(trim(p_copy_notes), ''), progress = jsonb_build_object('written', 0, 'total', 5, 'label', 'Reading the client''s notes'), updated_at = v_now
    where request_id = p_request;
  end if;

  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, body, data)
  values (p_request, 'review', 'client_review', v_to, p_by_profile,
          coalesce(nullif(trim(p_design_note), ''), nullif(trim(p_copy_notes), '')),
          jsonb_build_object('action', case when p_decision = 'approved' then 'client_approved' else 'client_revise' end,
                             'targets', to_jsonb(p_targets), 'by_name', p_by_name, 'round', v_round, 'testing', p_by_contact is null));
  return v_id;
end $$;
revoke execute on function public.client_decide(uuid, text, text[], text, text, uuid, uuid, text) from public, anon, authenticated;

-- ─── Copy goes to the client approved ───────────────────────────────────────
-- Sending to the client needs approved copy (a revised set is approved by copy review again first).
create or replace function public.move_request(p_request uuid, p_stage public.request_stage, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r     public.requests := private.assert_can_work(p_request);
  v_now timestamptz := now();
begin
  if r.stage = p_stage then return; end if;
  if p_stage not in ('requested', 'in_production') and not private.has_creative(p_request) then
    raise exception 'Upload the creative first. A ticket can''t move past production without it.';
  end if;
  if p_stage = 'client_review' and exists (select 1 from public.copy_sets where request_id = p_request and status <> 'approved') then
    raise exception 'Approve the copy first. It goes to the client together with the creative.';
  end if;
  update public.requests
  set stage = p_stage,
      stage_entered_at = v_now,
      stage_due_at = private.stage_due(p_stage, r.format, r.priority, v_now, r.created_at),
      assignee_id = coalesce(private.stage_owner(r, p_stage), r.assignee_id),
      launched_at = case when p_stage = 'launched' then v_now else null end
  where id = p_request;
  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, body)
  values (p_request, 'stage', r.stage, p_stage, private.current_profile_id(), nullif(trim(p_note), ''));
end $$;
