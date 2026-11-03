create table if not exists setup_help (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  step text not null,
  role text not null check (role in ('client','ai')),
  text text not null default '',
  files jsonb not null default '[]',
  by_name text,
  contact_id uuid,
  stuck boolean not null default false,
  frustration int not null default 0,
  suggest_call boolean not null default false,
  topic text,
  created_at timestamptz not null default now()
);
create index if not exists setup_help_client_idx on setup_help (client_id, step, created_at);
alter table setup_help enable row level security;
create policy "team reads setup help" on setup_help for select to authenticated using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_active));
