-- The organic social team works in Kaizen OS the way the email team does: audits that run themselves when a social
-- account goes red, sprints that follow an audit to done, and two Social Strategist skills online (the audit with its
-- sprint checks, and the client desk). The yardstick is the social account score (src/lib/social-score.ts), per
-- platform and overall.
--
-- Why new tables instead of the email ones: email_audits and email_sprints are read by client id alone everywhere
-- ("the client's latest audit"), so social rows in them would show on the email screens. Same shapes, own names.
-- Read policies check client access once per query (staff_sees_all, else the client in staff_client_ids). There is no
-- write policy: people act through server actions, which check access and write with the server's rights. Nothing is
-- deleted: a sprint is closed, an audit kept as history. Additive and idempotent: safe to run more than once.

-- 1. Social audits
create table if not exists public.social_audits (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  status      text not null default 'running' check (status in ('running', 'ready', 'failed')),
  step        text,
  progress    int not null default 0,
  score       int,                                    -- the social score when it ran (0 to 100, overall)
  band        text check (band in ('good', 'watch', 'bad')),
  result      jsonb,                                  -- verdict, causes, actions, tests, questions
  done        jsonb not null default '{}',            -- action index -> { by, at }
  inputs      jsonb not null default '{}',            -- the score snapshot (overall and per platform), counts
  auto        boolean not null default false,         -- started by the system because the account went red
  error       text,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists social_audits_client on public.social_audits (client_id, created_at desc);
alter table public.social_audits enable row level security;
drop policy if exists "staff read social audits" on public.social_audits;
create policy "staff read social audits" on public.social_audits for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

-- 2. Social sprints, their moves and their checks (each child carries the client, so its policy is the same check)
create table if not exists public.social_sprints (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  audit_id      uuid references public.social_audits (id) on delete set null,
  owner_id      uuid references public.profiles (id) on delete set null,
  watcher_ids   uuid[] not null default '{}',
  created_by    uuid references public.profiles (id) on delete set null,
  status        text not null default 'active' check (status in ('active', 'done', 'closed')),
  baseline      jsonb not null default '{}',
  latest        jsonb not null default '{}',
  last_check_at timestamptz,
  next_check_at timestamptz not null default now(),
  started_at    timestamptz not null default now(),
  closed_at     timestamptz,
  close_note    text
);
create index if not exists social_sprints_due on public.social_sprints (status, next_check_at) where status = 'active';
create index if not exists social_sprints_client on public.social_sprints (client_id, started_at desc);
create unique index if not exists social_sprints_one_active on public.social_sprints (client_id) where status = 'active';

create table if not exists public.social_sprint_actions (
  id          uuid primary key default gen_random_uuid(),
  sprint_id   uuid not null references public.social_sprints (id) on delete cascade,
  client_id   uuid not null references public.clients (id) on delete cascade,
  audit_index int,
  title       text not null,
  area        text,
  owner       text,
  platform    text,                                   -- instagram, facebook, tiktok or all
  "when"      text,
  steps       jsonb not null default '[]',
  why         text,
  impact      text,
  status      text not null default 'todo' check (status in ('todo', 'doing', 'done', 'skipped')),
  note        text,
  ai_note     text,
  done_by     uuid references public.profiles (id) on delete set null,
  done_at     timestamptz,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists social_sprint_actions_sprint on public.social_sprint_actions (sprint_id, sort_order);

create table if not exists public.social_sprint_checks (
  id            uuid primary key default gen_random_uuid(),
  sprint_id     uuid not null references public.social_sprints (id) on delete cascade,
  client_id     uuid not null references public.clients (id) on delete cascade,
  verdict       text not null check (verdict in ('no_action', 'on_track', 'improving', 'worse', 'done', 'started')),
  message       text not null,
  score         jsonb not null default '{}',
  next_check_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists social_sprint_checks_sprint on public.social_sprint_checks (sprint_id, created_at desc);

alter table public.social_sprints enable row level security;
alter table public.social_sprint_actions enable row level security;
alter table public.social_sprint_checks enable row level security;
drop policy if exists "staff read social sprints" on public.social_sprints;
create policy "staff read social sprints" on public.social_sprints for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));
drop policy if exists "staff read social sprint actions" on public.social_sprint_actions;
create policy "staff read social sprint actions" on public.social_sprint_actions for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));
drop policy if exists "staff read social sprint checks" on public.social_sprint_checks;
create policy "staff read social sprint checks" on public.social_sprint_checks for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

comment on table public.social_audits is 'An audit of one client''s organic social accounts against the social score; auto = started because the account went red';
comment on table public.social_sprints is 'A social audit''s plan followed to done; checks re-measure the social score and read the posts since';

-- 3. The Social Strategist's two skills, online (Sonnet: the team is waiting on them; an exec changes it in Settings)
insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select 'social_audit', 'Social audit', 'Audits a client''s Instagram, Facebook (and TikTok when read) against the social score: profile, content mix and cadence against the package, engagement quality, growth, top and bottom posts, hooks, formats and posting times; also reads each social sprint''s progress.', 'sonnet', 'medium', true, 90, '{}'::jsonb, 'social_strategist', ''
 where not exists (select 1 from public.ai_agents a where a.key = 'social_audit');
insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select 'social_desk', 'Social client desk', 'Answers the social team''s questions about a client in the client chat and on the Social sheet, from every platform''s numbers, the social score and the client''s context.', 'sonnet', 'medium', true, 91, '{}'::jsonb, 'social_strategist', ''
 where not exists (select 1 from public.ai_agents a where a.key = 'social_desk');
