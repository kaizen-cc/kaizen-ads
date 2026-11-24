-- Sales call briefs (owner, Nov 24 2026). Every half hour the team's Google Calendars are read for upcoming meetings
-- with people outside Kaizen who aren't a current client (src/lib/sales-briefs.ts). 18 hours before the call (or as
-- soon as it's booked, when that's later) the Sales agent writes a brief for whoever runs it: who they are, what they
-- said they want (the Calendly answers), fit and the Kaizen services that match, likely objections, discovery
-- questions, proof from similar clients and the next step. It's a Needs me item for that person (bell too), linked
-- from the prospect (made if new, stage "call booked"); refreshed when the event changes, removed when it's
-- cancelled. One brief per meeting, whoever's calendars it's on. The runner sees their own; execs and leads see all.

alter table public.prospects drop constraint if exists prospects_status_check;
alter table public.prospects add constraint prospects_status_check check (status in ('new', 'researched', 'contacted', 'call_booked', 'talking', 'proposal', 'won', 'lost'));

create table if not exists public.sales_call_briefs (
  id             uuid primary key default gen_random_uuid(),
  event_key      text not null unique,
  event_id       text,
  calendar_email text,
  prospect_id    uuid references public.prospects (id) on delete set null,
  owner_id       uuid references public.profiles (id) on delete set null,
  title          text not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz,
  organizer      text,
  attendees      jsonb not null default '[]'::jsonb,
  description    text,
  html_link      text,
  event_hash     text,
  status         text not null default 'pending' check (status in ('pending', 'ready', 'cancelled', 'done', 'failed')),
  brief          jsonb,
  error          text,
  made_at        timestamptz,
  notified_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists sales_call_briefs_owner on public.sales_call_briefs (owner_id, starts_at);
create index if not exists sales_call_briefs_due on public.sales_call_briefs (status, starts_at);
create index if not exists sales_call_briefs_prospect on public.sales_call_briefs (prospect_id, starts_at desc);
alter table public.sales_call_briefs enable row level security;
drop policy if exists "runner or execs and leads read sales briefs" on public.sales_call_briefs;
create policy "runner or execs and leads read sales briefs" on public.sales_call_briefs for select to authenticated
  using (owner_id = (select private.current_profile_id()) or (select private.is_exec_or_lead()));
drop policy if exists "execs and leads change sales briefs" on public.sales_call_briefs;
create policy "execs and leads change sales briefs" on public.sales_call_briefs for update to authenticated
  using (owner_id = (select private.current_profile_id()) or (select private.is_exec_or_lead()))
  with check (owner_id = (select private.current_profile_id()) or (select private.is_exec_or_lead()));
grant select, update on public.sales_call_briefs to authenticated;

-- The Sales agent's calls and chats about one prospect stay attached to it, so later ones continue with the context
alter table public.ai_role_calls add column if not exists prospect_id uuid references public.prospects (id) on delete set null;
create index if not exists ai_role_calls_prospect on public.ai_role_calls (prospect_id, started_at desc) where prospect_id is not null;

-- A brief delivered rings the person's assistant too (bell + heads-up), like a critical notice
create or replace function private.heads_up_from_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if new.read_at is null and (new.priority = 'critical' or new.kind in ('direction', 'sales_brief')) then
    select role::text into v_role from public.profiles where id = new.profile_id;
    if v_role in ('customer_success', 'onboarding_specialist', 'tracking_specialist')
       and (new.kind in ('direction', 'fatigue', 'ticket', 'bible') or coalesce(new.key, '') like 'bible%' or coalesce(new.key, '') like 'guideline-gap:%') then
      return new;
    end if;
    perform private.queue_heads_up(new.profile_id, 'n:' || new.key, new.title, new.body, new.href, new.client_id);
  end if;
  return new;
end $$;
