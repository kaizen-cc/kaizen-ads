-- The short, client-facing version of the Brand Bible ("Here's how we see you: are we getting this right?"). Written
-- once a new client's Bible is in; a lead approves it (or it goes out on its own after 24 hours); the client reacts
-- section by section in their portal and approves it.
create table if not exists client_presentations (
  client_id uuid primary key references clients(id) on delete cascade,
  status text not null default 'writing' check (status in ('writing', 'draft', 'held', 'sent', 'approved', 'failed')),
  deck jsonb,
  reactions jsonb not null default '{}',
  chat jsonb not null default '[]',
  drafted_at timestamptz,
  send_after timestamptz,
  sent_at timestamptz,
  sent_by uuid references profiles(id),
  sent_to text[] not null default '{}',
  viewed_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references contacts(id),
  error text,
  started_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table client_presentations enable row level security;
create policy "staff read presentations" on client_presentations for select using (private.staff_can_see_client(client_id));
