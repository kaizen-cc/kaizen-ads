-- Kaizen Ads — AI QA before creative review, and the copy studio
--
-- 1. The AI review now runs while the creative is being made, started by the designer or editor: they see its
--    notes, fix and replace files, run it again, then send it on (or send it anyway, which leads see). Every run is
--    kept, with live progress while it works, so the review history stays on the ticket.
-- 2. Copy: while the AI writes, the ticket has no assignee; the copywriter is assigned when the draft is ready.
--    The draft reports progress as it writes, the copywriter can chat with the agent that wrote it, and what
--    they teach it (and what their edits show) is kept as client memory with source 'copy'.

-- ─── 1. AI review runs ──────────────────────────────────────────────────────
alter table public.creative_ai_reviews rename to creative_ai_reviews_old;
alter index public.creative_ai_reviews_pkey rename to creative_ai_reviews_old_pkey;
create table public.creative_ai_reviews (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.requests(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  signature     text not null default '',            -- the design versions it looked at
  status        text not null default 'running' check (status in ('running', 'done', 'failed')),
  progress      jsonb not null default '{}',         -- {phase, files: {done, total, label}, designs: [{ref, name, status, fixes, watch}]}
  content       jsonb,                               -- {verdict, headline, notes: [...]}
  model         text,
  error         text,
  requested_by  uuid references public.profiles(id) on delete set null,
  started_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on public.creative_ai_reviews (request_id, started_at desc);
alter table public.creative_ai_reviews enable row level security;
-- The one-per-ticket reviews so far carry over as runs
insert into public.creative_ai_reviews (request_id, client_id, signature, status, content, model, error, started_at, updated_at)
select request_id, client_id, signature, case when status = 'running' then 'failed' else status end, content, model,
       case when status = 'running' then 'Stopped when the review moved earlier in the process.' else error end, started_at, updated_at
from public.creative_ai_reviews_old;
drop table public.creative_ai_reviews_old;
create policy "staff read creative ai review runs" on public.creative_ai_reviews for select to authenticated
  using (private.staff_can_see_client(client_id));

-- ─── 2. Copy ────────────────────────────────────────────────────────────────
alter table public.copy_sets add column progress jsonb not null default '{}';  -- {written, total, label} while drafting

create table public.copy_chats (
  request_id  uuid primary key references public.requests(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  messages    jsonb not null default '[]',  -- [{role: 'user' | 'assistant', text, by, at, rewrote}]
  updated_at  timestamptz not null default now()
);
alter table public.copy_chats enable row level security;
create policy "staff read copy chats" on public.copy_chats for select to authenticated using (private.staff_can_see_client(client_id));

alter table public.client_memory drop constraint client_memory_source_check;
alter table public.client_memory add constraint client_memory_source_check check (source in ('team', 'client', 'review', 'copy'));

-- Approving the creative hands it to the AI copywriter: nobody is assigned until the draft is ready
create or replace function public.review_creative(p_request uuid, p_decision text, p_note text default null) returns void
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
      assignee_id = case when v_to = 'copy' then null else coalesce(private.stage_owner(r, v_to), r.assignee_id) end
  where id = p_request;
  if p_decision = 'approve' then
    update public.review_comments set resolved_at = v_now, resolved_by = v_me
    where request_id = p_request and resolved_at is null and round = 'internal';
  end if;
  insert into public.request_events (request_id, kind, from_stage, to_stage, actor_id, body, data)
  values (p_request, 'review', r.stage, v_to, v_me, nullif(trim(p_note), ''),
          jsonb_build_object('decision', p_decision, 'open_comments', v_open));
end $$;
