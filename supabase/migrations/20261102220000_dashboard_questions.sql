-- What a client asks about their numbers on their portal dashboard, the answer, and whether the buyer was told
create table if not exists dashboard_questions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  asked_by text,
  question text not null,
  answer text not null,
  range jsonb,
  flagged boolean not null default false,
  topic text,
  created_at timestamptz not null default now()
);
create index if not exists dashboard_questions_client on dashboard_questions (client_id, created_at desc);
alter table dashboard_questions enable row level security;
create policy "staff read dashboard questions" on dashboard_questions for select using (private.staff_can_see_client(client_id));
