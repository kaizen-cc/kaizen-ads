-- The marketing intake in the client's portal: the questions tailored to them (by their services, how they sell and
-- their industry, with what we already know filled in), their answers as they go (resume any time), and the
-- onboarding call offered at the end (done-for-you or done-with-you, from how much setup is left).
create table if not exists public.client_intake_forms (
  client_id uuid primary key references public.clients(id) on delete cascade,
  form jsonb,
  answers jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'preparing', 'ready', 'submitted', 'failed')),
  error text,
  prepared_at timestamptz,
  started_at timestamptz,
  submitted_at timestamptz,
  submitted_by text,
  intake_id uuid references public.client_intakes(id) on delete set null,
  call_type text check (call_type in ('dfy', 'dwy')),
  call_reason text,
  computer text,
  call_booked_at timestamptz,
  asana_tasks jsonb,
  updated_at timestamptz not null default now()
);

alter table public.client_intake_forms enable row level security;

-- The team reads it for the clients they can see; the portal reads and writes through the server
drop policy if exists "team reads intake forms" on public.client_intake_forms;
create policy "team reads intake forms" on public.client_intake_forms for select to authenticated
  using (private.staff_can_see_client(client_id));

-- Each client's own Asana project (its title has their name and Client ID), found once and kept, for tasks the app
-- creates for teams not yet in Kaizen Ads
alter table public.clients add column if not exists asana_project_gid text;
