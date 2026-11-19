-- Every change Kaizen AI made inside a client's Klaviyo (owner, Nov 19 2026): who asked, the request, what it changed
-- in plain words, and whether Klaviyo took it. Written only after the person's own yes in the chat. Execs and the
-- email leads read it; nobody edits it.
create table if not exists public.klaviyo_ai_changes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  thread_id uuid,
  method text not null check (method in ('POST', 'PATCH')),
  path text not null,
  change text not null,
  body jsonb,
  ok boolean not null,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists klaviyo_ai_changes_client on public.klaviyo_ai_changes (client_id, created_at desc);
alter table public.klaviyo_ai_changes enable row level security;
drop policy if exists "klaviyo ai changes: execs, leads and the person" on public.klaviyo_ai_changes;
create policy "klaviyo ai changes: execs, leads and the person" on public.klaviyo_ai_changes for select to authenticated
  using (profile_id = (select auth.uid()) or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and (p.is_exec or p.is_lead)));
