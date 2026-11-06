-- Launch sheets: a buyer shares a launch sheet (PDF, Excel, CSV or a Google Sheets link) in a client's chat and the
-- Media Buyer launches it into Meta. One run per sheet: what was read (the sheet), what was checked against the ad
-- account (pages, files, sizes, posts, pixel, past dates, duplicates, spend), the questions only the buyer can answer
-- and their answers, the plan the conversation settled on, and its lines as they're checked and created.
-- Nothing is written to Meta until the buyer confirms the plan; each line keeps its Meta id, so a run that stopped
-- resumes where it left off and only failed lines are tried again (nothing is created twice).

create table public.launch_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  platform text not null default 'meta' check (platform in ('meta', 'google')),
  account text,
  created_by uuid references public.profiles(id),
  -- Where it was started: the client page chat (client_chats) or Kaizen AI (ai_threads)
  surface text not null default 'client_chat' check (surface in ('client_chat', 'kaizen_ai')),
  status text not null default 'reading' check (status in ('reading', 'resolving', 'asking', 'planning', 'checking', 'ready', 'applying', 'applied', 'partial', 'failed', 'set_aside', 'discarded')),
  -- The file or link it was read from
  source jsonb not null default '{}'::jsonb,
  sheet jsonb,
  -- What the Media Buyer read in it (a short summary for the buyer)
  summary text,
  resolution jsonb,
  questions jsonb not null default '[]'::jsonb,
  -- The conversation about this launch (buyer and Media Buyer turns)
  turns jsonb not null default '[]'::jsonb,
  plan jsonb,
  plan_warnings jsonb not null default '[]'::jsonb,
  qa jsonb,
  progress text,
  error text,
  confirmed_by uuid references public.profiles(id),
  confirmed_at timestamptz,
  applied_at timestamptz,
  -- A worker holds the run while it creates lines (so two clicks never create twice)
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index launch_runs_client on public.launch_runs (client_id, created_at desc);
create index launch_runs_open on public.launch_runs (client_id, created_by) where status not in ('applied', 'discarded', 'set_aside');

create table public.launch_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.launch_runs(id) on delete cascade,
  key text not null,
  kind text not null check (kind in ('campaign', 'adset', 'media', 'creative', 'ad')),
  position int not null default 0,
  parent_key text,
  label text not null default '',
  status text not null default 'planned' check (status in ('planned', 'valid', 'invalid', 'unchecked', 'creating', 'created', 'failed', 'skipped', 'existing')),
  meta_id text,
  -- Media: the library hash or video id; creatives and ads: what was sent
  detail jsonb not null default '{}'::jsonb,
  error text,
  help text,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, key)
);
create index launch_items_run on public.launch_items (run_id, position);

-- Staff who can see the client see its launches; only the server writes (after checking who may confirm)
alter table public.launch_runs enable row level security;
alter table public.launch_items enable row level security;
create policy "staff read launch runs" on public.launch_runs
  for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff read launch items" on public.launch_items
  for select to authenticated using (exists (select 1 from public.launch_runs r where r.id = run_id and private.staff_can_see_client(r.client_id)));
revoke insert, update, delete on public.launch_runs from anon, authenticated;
revoke insert, update, delete on public.launch_items from anon, authenticated;
