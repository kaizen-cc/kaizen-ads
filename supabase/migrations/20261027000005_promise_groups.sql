-- The same promise talked about in several places (two calls, both note-takers on one call, a Slack thread after):
-- one group per thing, with what every conversation added, so it's chased, briefed and closed once.
create table if not exists public.promise_groups (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null, -- the promise in a line, from all of them
  context text, -- what each conversation added: details, numbers, dates, who
  briefed_members text, -- the members a merged brief was written from (written again when that changes)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.call_commitments add column if not exists group_id uuid references public.promise_groups(id) on delete set null;
alter table public.message_promises add column if not exists group_id uuid references public.promise_groups(id) on delete set null;
alter table public.clients add column if not exists promises_grouped_at timestamptz;
create index if not exists call_commitments_group on public.call_commitments (group_id);
create index if not exists message_promises_group on public.message_promises (group_id);

alter table public.promise_groups enable row level security;
create policy "staff read promise groups for their clients" on public.promise_groups for select to authenticated using (private.staff_can_see_client(client_id));
