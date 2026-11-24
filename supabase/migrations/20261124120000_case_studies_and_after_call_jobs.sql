-- Case studies (their own client-ready template) are documents like the rest, and work the person approves on a call
-- keeps running after it ends: "I'm going to bed, execute all of these case studies" (Nov 21 2026). Each job is a list
-- of items done one after another in the background (src/lib/assistant/after-call-jobs.ts), each one told to the
-- person in the app with its file linked, optionally put into a Drive folder they named.
alter table public.kaizen_documents drop constraint if exists kaizen_documents_kind_check;
alter table public.kaizen_documents add constraint kaizen_documents_kind_check check (kind in ('sow', 'proposal', 'handoff', 'one_pager', 'case_study'));

create table if not exists public.after_call_jobs (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references public.profiles (id) on delete cascade,
  call_id        uuid references public.ai_role_calls (id) on delete set null,
  kind           text not null check (kind in ('case_studies')),
  title          text not null,
  items          jsonb not null default '[]',
  drive_folder   text,
  drive_subfolder text,
  drive_folder_id text,
  status         text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists after_call_jobs_open on public.after_call_jobs (status, created_at) where status in ('queued', 'running');
alter table public.after_call_jobs enable row level security;
-- Each person reads their own jobs (the assistant and their Overview show where they are); the server writes them
create policy "own after-call jobs" on public.after_call_jobs for select to authenticated using (profile_id = (select private.current_profile_id()));
