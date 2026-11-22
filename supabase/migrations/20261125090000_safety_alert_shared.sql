-- Shared safety alerts (Nov 22 2026): one exec dismissing a flagged call's alert clears it for every exec (it shows
-- as resolved, by whom and with what note, on the same /safety page for all of them), and the execs keep a comment
-- thread on the alert. Execs only, like the review itself; the server writes (the app checks the exec role).
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
