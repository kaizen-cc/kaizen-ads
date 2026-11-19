-- The system writes the creative briefs, the team approves them (Nov 19 2026 meeting, approved by the owner).
-- A brief is drafted the moment there's a reason (a time-sensitive ask from the client, hard fatigue, a KPI dropping)
-- or to keep the allotment on an even line through the client's billing cycle. It cites its real reason or it isn't
-- shown, it says the iteration / net new split the account's performance calls for, and it says how it sits against
-- the week's share of the allotment. The creative leads, the account's media buyer, the head of Meta and the execs
-- push it through (approval sends it to Asana), edit it, or reject it with a reason the strategist learns from.

alter table public.creative_suggestions
  -- Why it was drafted, once per reason: offer:<message id>, fatigue:<ad id>, kpi:<target>:<week>, pacing:<cycle>:<week>
  add column if not exists trigger_key text,
  -- A time-sensitive ask: the day it has to be live by
  add column if not exists deadline date,
  -- Ahead of the week's share on purpose (an urgent ask), said on the brief
  add column if not exists urgent boolean not null default false,
  -- { track: 'iterate' | 'net_new', iterate, netNew (percent), state: 'beating' | 'behind' | 'nothing' | 'unknown', reason }
  add column if not exists mix jsonb,
  -- { pool, cap, weekShare, dueByWeekEnd, asked, takes, over, line }
  add column if not exists pace jsonb,
  -- The real reason, from the data that set it off (never the AI's words): { source, ref, quote, at, numbers }
  add column if not exists citation jsonb,
  -- Whose ask it answers (client beats media buyer beats creative team)
  add column if not exists asked_by text check (asked_by in ('client', 'media_buyer', 'creative')),
  -- Swapped out for another brief before it was made
  add column if not exists replaced_by uuid references public.creative_suggestions (id) on delete set null;

-- Never drafted twice for the same reason, whatever became of the first
create unique index if not exists creative_suggestions_one_per_trigger on public.creative_suggestions (client_id, trigger_key) where trigger_key is not null;
-- One pacing draft open per client at a time: the even line is filled a brief at a time, never in a batch
create unique index if not exists creative_suggestions_one_pacing_draft on public.creative_suggestions (client_id) where status = 'open' and kind = 'pacing' and trigger_key is not null;
create index if not exists creative_suggestions_drafted_open on public.creative_suggestions (created_at desc) where status = 'open' and trigger_key is not null;

-- The old one-open-per-client rule stays for the strategist's older suggestions only: drafted briefs have their own
drop index if exists public.creative_suggestions_one_open;
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id)
  where status = 'open' and trigger_key is null and kind not in ('lab', 'winner', 'refresh', 'onboarding', 'call', 'market', 'pattern', 'idea');

-- Who can push a drafted brief through, by role: the head of creative, the lead video editor, the lead graphic
-- designer, the head of Meta and the executives (each the same everywhere); and the account's own Meta buyer
create or replace function private.is_brief_approver() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_exec or role in ('head_of_creative', 'head_of_meta', 'lead_graphic_designer', 'lead_video_editor') from public.profiles where auth_user_id = auth.uid() and is_active), false)
$$;

create or replace function private.my_meta_buyer_clients() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(client_id), '{}') from public.client_assignments where role = 'meta_buyer' and profile_id = private.current_profile_id()
$$;

-- Checked once per query, never per row (both functions are wrapped in a select)
create policy "approvers read drafted briefs" on public.creative_suggestions for select to authenticated
  using (trigger_key is not null and ((select private.is_brief_approver()) or client_id = any ((select private.my_meta_buyer_clients())::uuid[])));
create policy "approvers update drafted briefs" on public.creative_suggestions for update to authenticated
  using (trigger_key is not null and ((select private.is_brief_approver()) or client_id = any ((select private.my_meta_buyer_clients())::uuid[])))
  with check (trigger_key is not null and ((select private.is_brief_approver()) or client_id = any ((select private.my_meta_buyer_clients())::uuid[])));
create policy "approvers read drafted brief chat" on public.suggestion_messages for select to authenticated
  using (exists (select 1 from public.creative_suggestions s where s.id = suggestion_messages.suggestion_id and s.trigger_key is not null and ((select private.is_brief_approver()) or s.client_id = any ((select private.my_meta_buyer_clients())::uuid[]))));
create policy "approvers write drafted brief chat" on public.suggestion_messages for insert to authenticated
  with check (role = 'user' and author_id = (select private.current_profile_id()) and exists (select 1 from public.creative_suggestions s where s.id = suggestion_messages.suggestion_id and s.trigger_key is not null and ((select private.is_brief_approver()) or s.client_id = any ((select private.my_meta_buyer_clients())::uuid[]))));

-- Every swap: a brief (or an approved piece not started yet) given up for another. Work in production or later is
-- only swapped when a lead forces it, and then what's done is adapted (a direction change), never restarted.
create table if not exists public.brief_swaps (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  -- The billing cycle it happened in (3 or more in one cycle warns the leads)
  cycle_start date not null,
  replaced_kind text not null check (replaced_kind in ('draft', 'request', 'asana')),
  replaced_ref text not null,
  replaced_title text,
  replaced_stage text,
  replacement_id uuid references public.creative_suggestions (id) on delete set null,
  forced boolean not null default false,
  reason text,
  direction_change_id uuid,
  swapped_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists brief_swaps_by_cycle on public.brief_swaps (client_id, cycle_start);
alter table public.brief_swaps enable row level security;
create policy "approvers read swaps" on public.brief_swaps for select to authenticated
  using ((select private.is_brief_approver()) or client_id = any ((select private.my_meta_buyer_clients())::uuid[]));
