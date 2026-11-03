create table if not exists client_emails (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null,
  subject text not null,
  html text,
  text text,
  sent_to text[] not null default '{}',
  manual boolean not null default false,
  sent_by uuid references profiles(id) on delete set null,
  sent_at timestamptz not null default now()
);
create index if not exists client_emails_client_idx on client_emails (client_id, sent_at desc);
alter table client_emails enable row level security;
create policy "team reads client emails" on client_emails for select to authenticated using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_active));
