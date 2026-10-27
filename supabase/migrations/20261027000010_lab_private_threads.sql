-- Ads Lab: each person's conversations with the table are their own (execs can read everyone's, from their own tab).
-- Tests stay shared: everyone in the Lab sees every test, can leave a thought on it and follow how it does.
drop policy if exists "leads use lab threads" on public.lab_threads;
create policy "own lab threads, execs read all" on public.lab_threads for select to authenticated
  using (created_by = private.current_profile_id() or private.is_exec());
create policy "leads start lab threads" on public.lab_threads for insert to authenticated
  with check (private.is_exec_or_lead() and created_by = private.current_profile_id());
create policy "own lab threads change" on public.lab_threads for update to authenticated
  using (created_by = private.current_profile_id());
create policy "own lab threads delete" on public.lab_threads for delete to authenticated
  using (created_by = private.current_profile_id());

drop policy if exists "leads read lab messages" on public.lab_messages;
create policy "lab messages of own threads, execs all" on public.lab_messages for select to authenticated
  using (private.is_exec() or exists (select 1 from public.lab_threads t where t.id = thread_id and t.created_by = private.current_profile_id()));

-- Thoughts on a test, from anyone in the Lab; and who follows it (they hear when it's called)
create table if not exists public.lab_test_notes (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.lab_tests(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
alter table public.lab_test_notes enable row level security;
create policy "leads read lab notes" on public.lab_test_notes for select to authenticated using (private.is_exec_or_lead());
create policy "leads add lab notes" on public.lab_test_notes for insert to authenticated with check (private.is_exec_or_lead() and author_id = private.current_profile_id());
alter table public.lab_tests add column if not exists followers uuid[] not null default '{}';
