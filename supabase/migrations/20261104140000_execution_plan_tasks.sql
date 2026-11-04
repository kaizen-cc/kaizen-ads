-- The final execution plan: after the client approves their plan, the team reviews the Meta and Google go-to-market
-- strategies (keep, change, audiences, angles) in notes on the client page or on an internal strategy call, and the
-- strategist folds them into one plan: what we launch per platform, the testing, and a dated 30/60/90-day plan. A buyer
-- or lead signs it off, and it becomes the client's tasks: owned by role, dated, and waiting on each other (Meta can't
-- launch before the client approves the creative and access is in), so everyone sees what they're holding up.

create table if not exists public.client_execution_plans (
  client_id       uuid primary key references public.clients(id) on delete cascade,
  status          text not null default 'waiting' check (status in ('waiting', 'building', 'draft', 'final', 'failed')),
  missing         text[] not null default '{}',
  notes           text not null default '',          -- the team's keep / change notes, typed on the client page
  notes_at        timestamptz,
  call_ids        uuid[] not null default '{}',     -- internal strategy calls folded in
  plan            jsonb,                             -- the structured plan (platforms, phases, open items)
  markdown        text not null default '',
  error           text,
  started_at      timestamptz,
  generated_at    timestamptz,
  signed_off_at   timestamptz,
  signed_off_by   uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz not null default now()
);
alter table public.client_execution_plans enable row level security;
create policy "staff read execution plans" on public.client_execution_plans for select to authenticated using (private.staff_can_see_client(client_id));

-- The plan's tasks: one per step, keyed so dependencies survive a rebuilt plan
create table if not exists public.client_tasks (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  key         text not null,
  title       text not null,
  detail      text not null default '',
  platform    text not null default 'all' check (platform in ('meta', 'google', 'creative', 'all')),
  phase       text not null default 'setup' check (phase in ('setup', 'd30', 'd60', 'd90')),
  owner_role  text not null,                         -- meta_buyer, google_buyer, graphic_designer, video_editor, copywriter, coordinator, head_of_creative, lead, tracking, client
  owner_id    uuid references public.profiles(id) on delete set null,
  due_on      date,
  depends_on  text[] not null default '{}',          -- keys of the tasks it waits on
  auto        text,                                  -- the real event that completes it on its own
  status      text not null default 'blocked' check (status in ('blocked', 'ready', 'in_progress', 'done', 'skipped')),
  ready_at    timestamptz,
  done_at     timestamptz,
  done_by     uuid references public.profiles(id) on delete set null,
  done_how    text check (done_how in ('auto', 'manual')),
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (client_id, key)
);
create index if not exists client_tasks_owner on public.client_tasks (owner_id, status);
create index if not exists client_tasks_client on public.client_tasks (client_id, position);
alter table public.client_tasks enable row level security;
create policy "staff read client tasks" on public.client_tasks for select to authenticated using (private.staff_can_see_client(client_id));

-- The kickoff message to the client's external Slack channel: drafted once the intake form is in, the plan is approved
-- and the internal strategy meeting has happened; a buyer or lead reviews, edits and sends it. Never sent on its own,
-- never drafted twice.
create table if not exists public.client_kickoffs (
  client_id   uuid primary key references public.clients(id) on delete cascade,
  status      text not null default 'waiting' check (status in ('waiting', 'writing', 'draft', 'sent', 'failed')),
  missing     text[] not null default '{}',
  text        text not null default '',
  error       text,
  drafted_at  timestamptz,
  forced_by   uuid references public.profiles(id) on delete set null,
  sent_at     timestamptz,
  sent_by     uuid references public.profiles(id) on delete set null,
  sent_text   text,
  sent_as     text check (sent_as in ('person', 'app')),
  slack_ts    text,
  updated_at  timestamptz not null default now()
);
alter table public.client_kickoffs enable row level security;
create policy "staff read kickoffs" on public.client_kickoffs for select to authenticated using (private.staff_can_see_client(client_id));

-- Every message we post in a client's Slack channel at onboarding, kept like their emails: "Meet your team" (on its
-- own once the channel and the team are in, held as a draft while client outreach is held), a note when their team
-- changes, and the go-to-market and 90-day roadmap message (the kickoff, sent by a buyer or lead).
create table if not exists public.client_slack_messages (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  kind        text not null check (kind in ('meet_team', 'team_change', 'roadmap')),
  status      text not null check (status in ('held', 'sent', 'failed')),
  text        text not null,
  team        jsonb,                      -- the seats when it was written (role -> profile id), to spot a team change
  auto        boolean not null default false,
  error       text,
  sent_at     timestamptz,
  sent_by     uuid references public.profiles(id) on delete set null,
  sent_as     text check (sent_as in ('person', 'app')),
  slack_ts    text,
  created_at  timestamptz not null default now()
);
create index if not exists client_slack_messages_client on public.client_slack_messages (client_id, created_at desc);
create unique index if not exists client_slack_messages_one_meet on public.client_slack_messages (client_id) where kind = 'meet_team';
alter table public.client_slack_messages enable row level security;
create policy "staff read client slack messages" on public.client_slack_messages for select to authenticated using (private.staff_can_see_client(client_id));
