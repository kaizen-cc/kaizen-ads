-- Each connected person's own Asana > My tasks (Nov 25 2026: an exec's Claude runs create Asana tasks the OS never saw,
-- so it duplicated them and couldn't close its own items when he finished them in Asana). Open tasks and ones completed
-- in the last few days, read with their own token every half hour (src/lib/asana-person.ts). Separate from asana_tasks,
-- the Creative board's mirror, whose rows count against allotments. Read with the server's rights only.
create table if not exists public.asana_person_tasks (
  gid text not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  notes text,
  project text,
  client_id uuid references public.clients(id) on delete set null,
  due_on date,
  completed boolean not null default false,
  completed_at timestamptz,
  url text,
  asana_created_at timestamptz,
  asana_modified_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (gid, profile_id)
);
create index if not exists asana_person_tasks_client on public.asana_person_tasks (client_id) where client_id is not null;
create index if not exists asana_person_tasks_profile on public.asana_person_tasks (profile_id, completed);
alter table public.asana_person_tasks enable row level security;
