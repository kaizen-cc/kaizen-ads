-- Brand Bible governance, and one priority set on the Board.
--
-- 1. Asana's priority read as one set (normal, high, urgent): the mirror stored whatever the field said ("Hi",
--    "HIGH", "URGENT", "Urgent!!") or "urgent" from the title. From now on the sync writes 'high' / 'urgent' / null;
--    rows already mirrored are read the same way here.
update public.asana_tasks
set priority = case
    when priority ~* '(urgent|critical|asap|emergency|rush|\mp0\M|highest)' or name ~* '^\s*(\[\s*urgent\s*\]|urgent\s*[:!-])' or name ~* '\[\s*urgent\s*\]' then 'urgent'
    when priority ~* '(\mhi\M|\mhigh|important|\mp1\M)' or name ~* '^\s*(high|hi)\s+priority\s*[:!-]' then 'high'
    else null end
where priority is not null or name ~* 'urgent|priority';

-- 2. Who edits a client's Brand Bible: execs, leads (the Head of Creative among them) and the client's account
--    manager (their coordinator). Everyone else who works on the client reads it and proposes changes.
create or replace function private.can_edit_bible(p_client uuid)
 returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((
    select p.is_exec or p.is_lead or exists (
      select 1 from public.client_assignments a where a.client_id = p_client and a.profile_id = p.id and a.role = 'coordinator')
    from public.profiles p where p.auth_user_id = auth.uid() and p.is_active), false)
$$;

drop policy if exists "leads review brand bibles" on public.client_brand_bibles;
drop policy if exists "bible editors update brand bibles" on public.client_brand_bibles;
create policy "bible editors update brand bibles" on public.client_brand_bibles for update to authenticated
  using (private.can_edit_bible(client_id)) with check (private.can_edit_bible(client_id));

-- 3. Proposed changes to the Bible, decided by the approvers (execs, the Head of Creative, the account manager):
--    an avatar added, changed or retired (with the reason and the evidence, e.g. ad results), or a team answer to an
--    open question from someone who can't edit the Bible. Approved: applied to the Bible (an old or retired avatar
--    stays in it, labeled retired with the date). Rejected: kept, with why. Never deleted.
create table if not exists public.bible_changes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  kind text not null check (kind in ('avatar_add', 'avatar_change', 'avatar_retire', 'question_answer')),
  -- The avatar as the Bible names it now (change, retire)
  avatar text,
  -- The avatar as proposed (add, change): { name, tier, body }
  proposed jsonb,
  -- The open question it answers, and the answer
  question_id uuid references public.bible_questions (id) on delete set null,
  answer text,
  reason text not null default '',
  evidence text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  proposed_by uuid references public.profiles (id) on delete set null,
  proposed_by_name text,
  decided_by uuid references public.profiles (id) on delete set null,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create index if not exists bible_changes_client on public.bible_changes (client_id, created_at desc);
create index if not exists bible_changes_pending on public.bible_changes (client_id) where status = 'pending';
alter table public.bible_changes enable row level security;
drop policy if exists bible_changes_read on public.bible_changes;
create policy bible_changes_read on public.bible_changes for select to authenticated
  using (private.staff_can_see_client(client_id));
-- Written only by the server (proposals and decisions check who's asking there)
