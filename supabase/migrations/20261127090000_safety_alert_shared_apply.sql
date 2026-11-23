-- Shared safety alerts, applied again (Nov 23 2026). The change in 20261125090000_safety_alert_shared.sql may not have reached
-- the live database: the merge's database step couldn't connect, but the code went live, so Dismiss alert and the
-- comments on /safety/<call> answered "needs a quick database update". The merge pipeline applies only newly added
-- files, so the same change is repeated here. Safe to run more than once, and a no-op where it was already applied.
alter table public.call_safety_reviews add column if not exists resolved_at timestamptz;
alter table public.call_safety_reviews add column if not exists resolved_by uuid references public.profiles(id) on delete set null;
alter table public.call_safety_reviews add column if not exists resolution text;

create table if not exists public.call_safety_comments (
  id         uuid primary key default gen_random_uuid(),
  call_id    uuid not null references public.call_safety_reviews(call_id) on delete cascade,
  author_id  uuid references public.profiles(id) on delete set null,
  body       text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists call_safety_comments_call on public.call_safety_comments (call_id, created_at);

alter table public.call_safety_comments enable row level security;
drop policy if exists "call safety comments: execs read" on public.call_safety_comments;
create policy "call safety comments: execs read" on public.call_safety_comments for select to authenticated
  using ((select private.is_exec()));

notify pgrst, 'reload schema';
