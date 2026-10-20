-- A month's shot list for a client: what to ask them to film or photograph so next month's creative can be made,
-- written from what's planned, what's winning and what's already on Drive.
create table public.shot_lists (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  month date not null,
  list jsonb not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index shot_lists_client on public.shot_lists (client_id, created_at desc);
alter table public.shot_lists enable row level security;
create policy "staff read shot lists" on public.shot_lists for select to authenticated using (private.is_staff());
