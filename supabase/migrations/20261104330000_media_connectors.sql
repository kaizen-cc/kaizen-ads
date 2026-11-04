-- Media connectors: ElevenLabs (voiceovers), Higgsfield (AI images and videos) and Motion (references). Every
-- generation is one row here: who asked, for which client and ticket, what was sent, where it is now and what it
-- cost. Files live in the private `ai-media` bucket (read through short-lived signed links). Higgsfield runs in the
-- background: the row keeps Higgsfield's request id, so a refresh, another page or the cron picks it up and finishes it.
insert into storage.buckets (id, name, public) values ('ai-media', 'ai-media', false) on conflict (id) do nothing;

create table if not exists public.ai_media_jobs (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  client_id     uuid references public.clients(id) on delete set null,
  request_id    uuid references public.requests(id) on delete set null,
  provider      text not null check (provider in ('elevenlabs', 'higgsfield', 'motion')),
  kind          text not null check (kind in ('voiceover', 'image', 'video', 'reference')),
  -- The model or voice used (a Higgsfield model key, an ElevenLabs voice id), and a short name for the toast
  model         text,
  title         text,
  -- What was sent (prompt, settings, reference image path); never a key
  input         jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed', 'canceled')),
  -- The provider's own id for a background job (Higgsfield's request_id)
  external_id   text,
  -- Where the results are in the ai-media bucket: [{path, mime, bytes}]
  result_paths  jsonb not null default '[]'::jsonb,
  -- What it cost: ElevenLabs characters, Higgsfield credits when they're reported
  characters    int,
  credits       numeric,
  error         text,
  -- On the ticket's files (shown in its panels) and, when sent there, in the client's Drive
  attached_at   timestamptz,
  drive_note    text,
  expected_ms   int,
  attempts      int not null default 0,
  checked_at    timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  seen_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists ai_media_jobs_profile on public.ai_media_jobs (profile_id, created_at desc);
create index if not exists ai_media_jobs_request on public.ai_media_jobs (request_id, created_at desc) where request_id is not null;
create index if not exists ai_media_jobs_client on public.ai_media_jobs (client_id, created_at desc) where client_id is not null;
create index if not exists ai_media_jobs_open on public.ai_media_jobs (status, created_at) where status in ('queued', 'running');

alter table public.ai_media_jobs enable row level security;
-- Anyone on the team reads them (a ticket's voiceover is the whole team's); the server (service role) writes them
drop policy if exists "ai media jobs: staff read" on public.ai_media_jobs;
create policy "ai media jobs: staff read" on public.ai_media_jobs for select to authenticated using (private.is_staff());
