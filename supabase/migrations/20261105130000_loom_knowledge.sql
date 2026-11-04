-- Loom videos into the agents' knowledge. An exec records many Looms (how he reads and buys Meta and Google accounts,
-- and client situations). Each one that reaches us (a link posted in Slack, pushed by Zapier or an email rule to
-- /api/loom, or pasted in bulk in Settings or on a client) is one row here: read from Loom (title and transcript),
-- classified once by the Media Buyer, then filed: ad-buying method into the Media Buyer's knowledge (and the Google
-- auditor's for Google), a client situation into that client's knowledge, with its durable decisions as dated memory.
-- A video whose client isn't clear waits in Settings for someone to assign it. Nothing is deleted.

-- Shared Loom folders (anyone with the link) read like the folder's share page does, every video queued, and checked
-- again daily so new recordings in them come in by themselves. A folder can point at one client.
create table if not exists public.loom_folders (
  id              uuid primary key default gen_random_uuid(),
  folder_id       text not null unique,
  url             text not null,
  name            text,
  client_id       uuid references public.clients(id) on delete set null,
  -- What the folder holds, when someone says so: method (ad-buying lessons) or client (one client's situations)
  agent_hint      text check (agent_hint in ('method', 'client')),
  last_checked_at timestamptz,
  video_count     int not null default 0,
  error           text,
  "by"            uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
alter table public.loom_folders enable row level security;
drop policy if exists "staff read loom folders" on public.loom_folders;
create policy "staff read loom folders" on public.loom_folders for select to authenticated using (private.is_staff());

create table if not exists public.loom_videos (
  id            uuid primary key default gen_random_uuid(),
  loom_id       text not null unique,
  url           text not null,
  title         text,
  description   text,
  -- The Loom folder it came from, when the intake path knows it (Zapier sends it)
  folder        text,
  transcript    text,
  -- queued: waiting to be read · reading: being read and filed · filed: in the knowledge · review: needs a client
  -- assigned by hand · failed: couldn't be read (the error says what to change in Loom) · skipped: not about ad buying
  -- or a client (internal, admin, personal): kept as a record, not filed
  status        text not null default 'queued' check (status in ('queued', 'reading', 'filed', 'review', 'failed', 'skipped')),
  folder_ref    uuid references public.loom_folders(id) on delete set null,
  -- method: ad-buying lessons · client: a client situation · both · other: neither (kept, not filed)
  kind          text check (kind in ('method', 'client', 'both', 'other')),
  platform      text check (platform in ('meta', 'google', 'both', 'none')),
  -- The client it's about (the first, when it's about several: the rest are in client_ids)
  client_id     uuid references public.clients(id) on delete set null,
  client_ids    uuid[] not null default '{}',
  -- The client the intake path pointed at (the Slack channel it was posted in, the client page it was pasted on)
  hint_client_id uuid references public.clients(id) on delete set null,
  hint_client   text,
  -- The agent knowledge it was filed to (role:media_buyer, google_auditor)
  agent_keys    text[] not null default '{}',
  summary       text,
  -- The classification as written: lessons, the client situation, memory notes, why each client
  result        jsonb not null default '{}'::jsonb,
  doc_ids       uuid[] not null default '{}',
  error         text,
  attempts      int not null default 0,
  next_at       timestamptz not null default now(),
  source        text not null check (source in ('slack', 'webhook', 'bulk', 'client', 'folder')),
  -- Where it was seen (a Slack message link), so it can be traced
  source_ref    text,
  recorded_at   timestamptz,
  "by"          uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists loom_videos_status on public.loom_videos (status, next_at);
create index if not exists loom_videos_client on public.loom_videos (client_id);
create index if not exists loom_videos_hint on public.loom_videos (hint_client_id);
create index if not exists loom_videos_folder on public.loom_videos (folder_ref);

-- The Loom status block: how many in each state, by intake path and by where they were filed
create or replace function public.loom_counts()
returns table (status text, source text, kind text, to_media_buyer boolean, to_google boolean, to_client boolean, n bigint)
language sql stable set search_path = public as $$
  select status, source, coalesce(kind, ''), 'role:media_buyer' = any(agent_keys), 'google_auditor' = any(agent_keys), client_id is not null and status = 'filed', count(*)
  from public.loom_videos group by 1, 2, 3, 4, 5, 6;
$$;
revoke all on function public.loom_counts() from public, anon, authenticated;
grant execute on function public.loom_counts() to service_role;

alter table public.loom_videos enable row level security;
drop policy if exists "staff read loom videos" on public.loom_videos;
create policy "staff read loom videos" on public.loom_videos for select to authenticated using (private.is_staff());

-- One queued video for one worker: whatever is due, oldest first (a video left reading over 15 minutes is taken again)
create or replace function public.claim_loom_video()
returns setof public.loom_videos
language sql volatile set search_path = public as $$
  update public.loom_videos v set status = 'reading', attempts = v.attempts + 1, updated_at = now()
  where v.id = (
    select id from public.loom_videos
    where (status = 'queued' and next_at <= now()) or (status = 'reading' and updated_at < now() - interval '15 minutes')
    order by next_at, created_at
    limit 1
    for update skip locked
  )
  returning v.*;
$$;
revoke all on function public.claim_loom_video() from public, anon, authenticated;
grant execute on function public.claim_loom_video() to service_role;

-- What Kaizen's senior buyer teaches in his Looms, distilled into layers the Media Buyer is built from: principles
-- (what he believes and why), decision rules (if this, then that, with his thresholds), situational cases (the account,
-- how he read it, what he did, the outcome), diagnostics (what he checks first, the columns, the order) and voice (how
-- he explains and pushes back). Each item quotes its moment. Consolidation merges near-duplicates across videos (the
-- support count is how many videos say it), flags contradictions for an exec to rule on, and rewrites the generated
-- skills from the best-supported items. Nothing is deleted: merged items point at the one they joined, ruled-out items
-- are excluded.
create table if not exists public.media_buying_insights (
  id              uuid primary key default gen_random_uuid(),
  layer           text not null check (layer in ('principle', 'rule', 'case', 'diagnostic', 'voice')),
  body            text not null,
  -- industry, business model, budget, and for a case its situation, read, action and outcome
  tags            jsonb not null default '{}'::jsonb,
  platform        text not null default 'none' check (platform in ('meta', 'google', 'both', 'none')),
  industry        text,
  client_id       uuid references public.clients(id) on delete set null,
  loom_video_id   uuid references public.loom_videos(id) on delete set null,
  loom_id         text,
  quote           text,
  at_seconds      int,
  -- The Loom videos that say it (grows as duplicates merge in); confidence = how many
  videos          text[] not null default '{}',
  confidence      int not null default 1,
  merged_into     uuid references public.media_buying_insights(id) on delete set null,
  consolidated_at timestamptz,
  -- A contradiction for an exec to rule on: with another item, or with a hand-written skill (its title)
  conflict_with   uuid references public.media_buying_insights(id) on delete set null,
  conflict_skill  text,
  conflict_note   text,
  ruling          text check (ruling in ('keep', 'drop', 'both')),
  ruled_by        uuid references public.profiles(id) on delete set null,
  ruled_at        timestamptz,
  -- Ruled out (kept for the record, not used in the skills)
  excluded        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists media_buying_insights_layer on public.media_buying_insights (layer, confidence desc) where merged_into is null and not excluded;
create index if not exists media_buying_insights_new on public.media_buying_insights (layer) where consolidated_at is null and merged_into is null;
create index if not exists media_buying_insights_video on public.media_buying_insights (loom_video_id);
alter table public.media_buying_insights enable row level security;
drop policy if exists "staff read buying insights" on public.media_buying_insights;
create policy "staff read buying insights" on public.media_buying_insights for select to authenticated using (private.is_staff());

-- A knowledge document can be text from a link (a Loom's transcript), not only an uploaded file: where it came from
alter table public.knowledge_docs add column if not exists source_url text;

-- Client memory written from a Loom
alter table public.client_memory drop constraint if exists client_memory_source_check;
alter table public.client_memory add constraint client_memory_source_check check (source = any (array['team', 'client', 'review', 'copy', 'lab', 'audit', 'sprint', 'network', 'call', 'drive', 'doc', 'loom']));
