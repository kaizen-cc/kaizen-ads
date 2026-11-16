-- The email team works in Kaizen Ads the way the Meta and Google buyers do: audits that run themselves when an account
-- goes red, sprints that follow an audit to done, three role agents online, a client chat that knows the Klaviyo data,
-- and campaign suggestions tracked like creative ideas (Nov 2026).
--
-- Why new tables instead of the ads ones: account_audits, optimization_sprints and their children hang on kpi_targets
-- (an ad account, a KPI, a conversion) and the six email and social positions are denied them by private.sees_paid_ads().
-- An email account has no ad account and no KPI target; its yardstick is the seven-check email score
-- (src/lib/email-score.ts). So email gets the same shapes under its own names, readable by anyone who can see the client.
-- There is no write policy anywhere here: people act through server actions, which check access and write with the
-- server's rights. Nothing is deleted: a sprint is closed, a suggestion dismissed, an audit kept as history.
--
-- Additive and idempotent: safe to run more than once.

-- 1. Email audits: one Klaviyo account scrubbed against the score, its own 90 days, the client's context
create table if not exists public.email_audits (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  status      text not null default 'running' check (status in ('running', 'ready', 'failed')),
  step        text,                                   -- what it is doing now, for the progress bar
  progress    int not null default 0,
  score       int,                                    -- the email score when it ran (0 to 100)
  band        text check (band in ('good', 'watch', 'bad')),
  result      jsonb,                                  -- verdict, findings, actions, tests, questions
  done        jsonb not null default '{}',            -- action index -> { by, at }
  inputs      jsonb not null default '{}',            -- what it read (counts, the score's checks), for the footer
  auto        boolean not null default false,         -- started by the system because the account went red
  error       text,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists email_audits_client on public.email_audits (client_id, created_at desc);
alter table public.email_audits enable row level security;
drop policy if exists "staff read email audits" on public.email_audits;
create policy "staff read email audits" on public.email_audits for select to authenticated
  using (private.staff_can_see_client(client_id));

-- 2. Email sprints: an audit's plan followed through with the strategist, re-measured against the score
create table if not exists public.email_sprints (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  audit_id      uuid references public.email_audits (id) on delete set null,
  owner_id      uuid references public.profiles (id) on delete set null,
  watcher_ids   uuid[] not null default '{}',
  created_by    uuid references public.profiles (id) on delete set null,
  status        text not null default 'active' check (status in ('active', 'done', 'closed')),
  baseline      jsonb not null default '{}',          -- the score and its checks when it started
  latest        jsonb not null default '{}',          -- the score and its checks at the last check
  last_check_at timestamptz,
  next_check_at timestamptz not null default now(),
  started_at    timestamptz not null default now(),
  closed_at     timestamptz,
  close_note    text
);
create index if not exists email_sprints_due on public.email_sprints (status, next_check_at) where status = 'active';
create index if not exists email_sprints_client on public.email_sprints (client_id, started_at desc);
-- One live sprint per client
create unique index if not exists email_sprints_one_active on public.email_sprints (client_id) where status = 'active';

create table if not exists public.email_sprint_actions (
  id          uuid primary key default gen_random_uuid(),
  sprint_id   uuid not null references public.email_sprints (id) on delete cascade,
  audit_index int,                                    -- which action of the audit's plan it came from
  title       text not null,
  area        text,
  owner       text,
  "when"      text,
  steps       jsonb not null default '[]',
  why         text,
  impact      text,
  status      text not null default 'todo' check (status in ('todo', 'doing', 'done', 'skipped')),
  note        text,
  ai_note     text,                                   -- what the last check saw about this action
  done_by     uuid references public.profiles (id) on delete set null,
  done_at     timestamptz,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists email_sprint_actions_sprint on public.email_sprint_actions (sprint_id, sort_order);

create table if not exists public.email_sprint_checks (
  id            uuid primary key default gen_random_uuid(),
  sprint_id     uuid not null references public.email_sprints (id) on delete cascade,
  verdict       text not null check (verdict in ('no_action', 'on_track', 'improving', 'worse', 'done', 'started')),
  message       text not null,                        -- to the strategist, first person
  score         jsonb not null default '{}',          -- the score and its checks at this check
  next_check_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists email_sprint_checks_sprint on public.email_sprint_checks (sprint_id, created_at desc);

alter table public.email_sprints enable row level security;
alter table public.email_sprint_actions enable row level security;
alter table public.email_sprint_checks enable row level security;
drop policy if exists "staff read email sprints" on public.email_sprints;
create policy "staff read email sprints" on public.email_sprints for select to authenticated
  using (private.staff_can_see_client(client_id));
drop policy if exists "staff read email sprint actions" on public.email_sprint_actions;
create policy "staff read email sprint actions" on public.email_sprint_actions for select to authenticated
  using (exists (select 1 from public.email_sprints s where s.id = sprint_id and private.staff_can_see_client(s.client_id)));
drop policy if exists "staff read email sprint checks" on public.email_sprint_checks;
create policy "staff read email sprint checks" on public.email_sprint_checks for select to authenticated
  using (exists (select 1 from public.email_sprints s where s.id = sprint_id and private.staff_can_see_client(s.client_id)));

-- 3. Campaign suggestions, tracked like creative ideas: where each came from (with the quote and the link), where it
--    stands, and whether it worked once it ran
create table if not exists public.email_suggestions (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  origin        text not null check (origin in ('performance', 'calendar', 'slack', 'email', 'call')),
  title         text not null,
  idea          text not null,                        -- the campaign in a few sentences: offer, audience, angle
  why           text,
  evidence      jsonb not null default '[]',          -- the numbers or moments behind it
  subjects      jsonb not null default '[]',          -- subject line options from the email designer
  send_on       date,                                 -- the day it should go out, when it's tied to one
  source_quote  text,                                 -- the words from Slack, email or a call it came from
  source_url    text,
  source_at     timestamptz,
  status        text not null default 'new' check (status in ('new', 'in_motion', 'done', 'dismissed')),
  outcome       text check (outcome in ('worked', 'not_worked')),
  outcome_note  text,
  outcome_at    timestamptz,
  dismiss_reason text,
  status_by     uuid references public.profiles (id) on delete set null,
  status_at     timestamptz,
  dedupe_key    text,                                 -- the same moment or idea isn't suggested twice
  created_at    timestamptz not null default now()
);
create index if not exists email_suggestions_client on public.email_suggestions (client_id, status, created_at desc);
create unique index if not exists email_suggestions_dedupe on public.email_suggestions (client_id, dedupe_key) where dedupe_key is not null;
alter table public.email_suggestions enable row level security;
drop policy if exists "staff read email suggestions" on public.email_suggestions;
create policy "staff read email suggestions" on public.email_suggestions for select to authenticated
  using (private.staff_can_see_client(client_id));

-- When each client's suggestions were last written (so the hourly step spreads out) and the last audit refresh
create table if not exists public.email_ops_state (
  client_id          uuid primary key references public.clients (id) on delete cascade,
  suggestions_at     timestamptz,
  suggestions_error  text,
  updated_at         timestamptz not null default now()
);
alter table public.email_ops_state enable row level security;
drop policy if exists "staff read email ops state" on public.email_ops_state;
create policy "staff read email ops state" on public.email_ops_state for select to authenticated
  using (private.staff_can_see_client(client_id));

comment on table public.email_audits is 'An audit of one client''s Klaviyo account against the email score; auto = started because the account went red';
comment on table public.email_sprints is 'An email audit''s plan followed to done; checks re-measure the score';
comment on table public.email_suggestions is 'Campaign ideas for an email client (past performance, the calendar, what Slack, email and calls mention), tracked in app only';

-- 4. The three email agents online, with a starter core each. Only a placeholder core is replaced, so an edit made in
--    Settings > AI agents is never overwritten by running this again.
update public.ai_roles set
  offline = false,
  description = 'Email strategy for each client: reads the Klaviyo account against the email score, audits it, runs sprints to fix what is weighing it down, and plans the campaigns the list should get next.',
  core = $core$You are Kaizen Marketing's Email Strategist, the role that owns the strategy and the numbers for each client's email program in Klaviyo. You work for the email strategist who holds the client, and for the Head of Email. Refer to people by role, never by name. No em dashes.

Status of this playbook: Kaizen's email playbook is being written from Kaizen's own calls and Loom history and is approved by the Head of Email. Until its skills are added here, work from this core, the client's Brand Bible and memory, and the numbers you are given. Say plainly when something is not backed by the client's own data yet, and never invent a benchmark.

How Kaizen judges an email account: one score from 0 to 100 over the last 30 days, built from seven checks, each with a bar and a weight. Money weighs most.
- Attributed revenue (20 points): Klaviyo-attributed revenue as a share of the store's revenue, bar 30 percent.
- Revenue per recipient (20): attributed revenue divided by recipients across campaigns and flows, bar $0.15.
- Deliverability (15): Kaizen's own score from bounces, spam complaints, unsubscribes and opens, bar 65.
- Campaign open rate (11): bar 30 percent. Campaign click rate (11): bar 1 percent.
- Flow open rate (11): bar 35 percent. Flow click rate (12): bar 1.5 percent.
A check at or over its bar earns all its points; under it, its share of the bar. Green from 80, yellow from 60, red under 60. A check with nothing to measure is left out, never counted as a failure.

How you work:
- Data first. Every claim names the numbers behind it (the check, the value against its bar, the campaign or flow). If the data is thin, say so and say what would settle it.
- Proactive. Do not wait to be asked: when the score slips, a key flow is missing, deliverability turns, or a seasonal moment is coming, say so with the move to make and who makes it.
- Order by money and risk. Fix deliverability first when it is under the bar (it caps everything), then the flows that earn while nobody works (welcome, abandoned checkout or cart, browse, post-purchase, winback), then campaign cadence, offers, segmentation and subject lines.
- Protect the list. Never recommend sending harder to a list that is bouncing, complaining or unsubscribing; recommend a smaller, warmer segment first.
- Read only. Nothing here sends, edits or schedules in Klaviyo. Moves are made by the email team in Klaviyo and ticked off in Kaizen Ads.
- Respect the client's rules (what they told us to avoid, claims never to make, regulated categories).$core$
 where key = 'email_strategist' and core like 'Placeholder:%';

update public.ai_roles set
  offline = false,
  label = 'Email designer',
  description = 'Email design direction and copy on brand: subject lines, preview text, body copy and the layout direction for each email, judged by what the client''s own list opened and clicked.',
  core = $core$You are Kaizen Marketing's Email Designer, the role that turns an email strategy into the email itself: the subject line and preview text, the copy and the layout direction, on the client's brand. You work with the email strategist and the email builder. Refer to people by role, never by name. No em dashes.

Status of this playbook: Kaizen's email playbook is being written from Kaizen's own calls and Loom history and is approved by the Head of Email. Until its skills are added here, work from this core, the client's Brand Bible (voice, claims, what to avoid) and the client's own sends.

What good looks like, in Kaizen's terms: an email is judged on the same checks as the account. Campaign open rate against 30 percent, campaign click rate against 1 percent, flow open rate against 35 percent, flow click rate against 1.5 percent, and revenue per recipient against $0.15. Deliverability (bar 65) is protected by not baiting opens: no misleading subject lines, no spammy capitals, no unsubscribes provoked by pressure.

How you work:
- Data first. Before proposing a subject line, look at which traits won for this client (a question, a number, urgency, length, an emoji) and which lost, and say which you are leaning on and why.
- One idea per email, one clear call to action, scannable on a phone first. Subject and preview text work as a pair: the preview adds, it does not repeat.
- Offer a few options, not one: different angles, each in the client's voice, each within the claims the client allows.
- Proactive. When a campaign is suggested, bring its subject options and the layout direction with it, so the builder can start.
- Read only. You write and direct; nothing is sent or scheduled from Kaizen Ads.$core$
 where key = 'email_creative' and core like 'Placeholder:%';
-- Renamed in the app (the seat is "email designer"); a renamed role stays renamed
update public.ai_roles set label = 'Email designer' where key = 'email_creative' and label = 'Email Creative';

update public.ai_roles set
  offline = false,
  description = 'Builds the emails and flows in Klaviyo from approved work: lays out what a build needs (template, segment, flow steps, tracking), checks it against the score, and keeps writing to Klaviyo off until it is switched on.',
  core = $core$You are Kaizen Marketing's Email Builder, the role that builds approved emails and flows in Klaviyo: templates, campaigns as drafts, flow steps, segments and tracking. You work from the email strategist's plan and the email designer's direction. Refer to people by role, never by name. No em dashes.

Status of this playbook: Kaizen's email playbook is being written from Kaizen's own calls and Loom history and is approved by the Head of Email. Until its skills are added here, work from this core and say plainly when a step needs a person to decide.

What matters in a build, against Kaizen's seven checks: the right segment and a suppressed unengaged tail (deliverability, bar 65), flow triggers and timing that match the customer's moment (flow open bar 35 percent, flow click bar 1.5 percent), UTM and revenue attribution that actually counts (attributed revenue bar 30 percent of store revenue, revenue per recipient bar $0.15), and a working link, preview text and plain-text version on every email.

How you work:
- Data first, checklist second: for each build, list what must be true before it goes live and what you checked.
- Never send. A campaign is built as a draft and a flow in draft, for the email team to review; nothing goes out from Kaizen Ads, and writing to Klaviyo stays off until it is switched on for the client.
- Proactive. If the plan would send to a segment that is bouncing, complaining or unengaged, or a key flow is missing a step, say so before building.$core$
 where key = 'email_builder' and core like 'Placeholder:%';

-- 5. The skills the app now runs (Sonnet by default; an exec changes it in Settings)
update public.ai_agents set
  live = true,
  model = 'sonnet',
  effort = 'medium',
  description = 'Audits a client''s Klaviyo account against the email score and writes the findings and the plan; also reads each sprint''s progress and re-measures the score.'
 where key = 'email_audit' and live = false;
update public.ai_agents set
  live = true,
  model = 'sonnet',
  effort = 'medium',
  description = 'Suggests the campaigns a client''s list should get next, from what worked in past sends, the calendar and what the client has mentioned in Slack, email and calls.'
 where key = 'email_calendar' and live = false;
update public.ai_agents set
  live = true,
  model = 'sonnet',
  effort = 'low',
  description = 'Writes subject line options for each suggested campaign in the client''s voice.'
 where key = 'email_copy' and live = false;

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select 'email_desk', 'Email client desk', 'Answers the email team''s questions about a client in the client chat, from the Klaviyo data, the email score and the client''s context.', 'sonnet', 'medium', true, 86, '{}'::jsonb, 'email_strategist', ''
 where not exists (select 1 from public.ai_agents a where a.key = 'email_desk');
