-- From the C-suite account review call.
--  1. csuite_meetings: the weekly full-account review, run step by step (Scorecard, Critical accounts, Issues, Upsell,
--     Financial overview, Decisions and to-dos). Each item's state (discuss / done) and the step reached are saved per
--     meeting, with the numbers as they were when it started. Execs only.
--  2. csuite_todos: decisions and to-dos captured in a meeting, each with a person and a due date; they land on that
--     person's Overview. Execs read and write them all; the person they're assigned to reads and closes their own.
--  3. client_email_drafts: emails to a client the app drafted from calls, meeting notes, promises, Slack and email (a
--     promise, a follow-up, an apology or correction, an upsell offer, a requested report), from the person responsible.
--     Listed on that person's Overview as "Emails ready to send". Never sent automatically. The owner reads and updates
--     their own; execs read every one.
--  4. The diagnosis tree (if-then) for the strategist and the media buyer's audits, as skills.
-- Every policy checks access once per query (a select of the helper), never per row. Additive and idempotent.

create table if not exists public.csuite_meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Weekly account review',
  status text not null default 'open' check (status in ('open', 'closed')),
  step integer not null default 0 check (step between 0 and 5),
  -- { "<item key>": { "state": "discuss" | "done", "note": "...", "at": "..." } }
  items jsonb not null default '{}'::jsonb,
  notes text,
  -- The scorecard as it stood when the meeting started (success ratio, lines, critical count)
  snapshot jsonb,
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists csuite_meetings_recent on public.csuite_meetings (started_at desc);
alter table public.csuite_meetings enable row level security;
drop policy if exists "execs run account reviews" on public.csuite_meetings;
create policy "execs run account reviews" on public.csuite_meetings for all to authenticated
  using ((select private.is_exec())) with check ((select private.is_exec()));

create table if not exists public.csuite_todos (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references public.csuite_meetings(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  -- The agenda item it came from ("critical:<client id>", "upsell:<client id>:<service>"), when it did
  item_key text,
  title text not null,
  detail text,
  assignee_id uuid not null references public.profiles(id) on delete cascade,
  due_on date,
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  done_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists csuite_todos_mine on public.csuite_todos (assignee_id, status, due_on);
create index if not exists csuite_todos_meeting on public.csuite_todos (meeting_id);
alter table public.csuite_todos enable row level security;
drop policy if exists "execs manage review todos" on public.csuite_todos;
create policy "execs manage review todos" on public.csuite_todos for all to authenticated
  using ((select private.is_exec())) with check ((select private.is_exec()));
drop policy if exists "assignee reads review todos" on public.csuite_todos;
create policy "assignee reads review todos" on public.csuite_todos for select to authenticated
  using (assignee_id = (select private.current_profile_id()));
drop policy if exists "assignee closes review todos" on public.csuite_todos;
create policy "assignee closes review todos" on public.csuite_todos for update to authenticated
  using (assignee_id = (select private.current_profile_id())) with check (assignee_id = (select private.current_profile_id()));

create table if not exists public.client_email_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'follow_up' check (kind in ('promise', 'follow_up', 'apology', 'upsell', 'report', 'other')),
  subject text not null,
  body text not null,
  to_emails text[] not null default '{}',
  -- Why it was drafted, in a line ("Promised a new landing page by Friday on the Nov 12 call")
  reason text,
  source_kind text not null default 'call' check (source_kind in ('call', 'commitment', 'slack', 'email', 'upsell', 'meeting', 'assistant')),
  source_id text,
  -- One draft per thing that needs it: a scan that finds the same promise again doesn't draft it twice
  source_key text not null unique,
  status text not null default 'ready' check (status in ('ready', 'opened', 'dismissed', 'sent')),
  gmail_draft_id text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists client_email_drafts_mine on public.client_email_drafts (owner_id, status, created_at desc);
create index if not exists client_email_drafts_client on public.client_email_drafts (client_id, created_at desc);
alter table public.client_email_drafts enable row level security;
drop policy if exists "owner reads email drafts" on public.client_email_drafts;
create policy "owner reads email drafts" on public.client_email_drafts for select to authenticated
  using (owner_id = (select private.current_profile_id()) or (select private.is_exec()));
drop policy if exists "owner updates email drafts" on public.client_email_drafts;
create policy "owner updates email drafts" on public.client_email_drafts for update to authenticated
  using (owner_id = (select private.current_profile_id())) with check (owner_id = (select private.current_profile_id()));

-- The diagnosis tree: for the strategist, and for the media buyer's account audits (Meta, Google, TikTok where it
-- exists). Logged as skills like the rest of each agent's knowledge, editable on the agent's page.
insert into public.ai_knowledge (agent_key, kind, title, body, active)
select a.key, 'skill', 'Diagnosis: find the core issue first', $k$Before recommending anything, find the core issue. Cost per result is CPM divided by (click-through rate x conversion rate), so a worse result comes from one of three places. Compare the last 14 days with the 14 before and name the one that moved most.
If conversion rate is the problem: first confirm the traffic quality (click-through rate, landing page view rate, the audience it's reaching). If the traffic is good, the fix is a website or landing page update (offer, speed, form, proof, match with the ad), not new ads.
If click-through rate is too low with weak engagement (thumb-stop, hold, reactions): run a competitive analysis of what's working for competitors right now (hooks, angles, formats, offers) and make those.
If CPM is the issue: look at audience size (too narrow for the spend), frequency (the same people seeing it too often), seasonality (auctions get pricier around holidays and events) and creative quality (low-quality or low-engagement ads cost more to deliver).
Say which branch you're on and the numbers that put you there, then give the fix for that branch only.$k$, true
from public.ai_agents a
where a.key in ('strategist', 'auditor', 'google_auditor', 'tiktok_auditor')
  and not exists (select 1 from public.ai_knowledge k where k.agent_key = a.key and k.title = 'Diagnosis: find the core issue first');
