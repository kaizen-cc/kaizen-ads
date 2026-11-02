-- A new client's onboarding guide in their portal: access to their Meta business (Kaizen as a partner, our team as
-- admin) and their Google Ads account ID, their assets, and the style and pacing they want. Each step's state is kept
-- here; access is checked against Meta and our Google manager account, not taken on trust.
create table if not exists client_onboarding (
  client_id uuid primary key references clients(id) on delete cascade,
  meta jsonb not null default '{}',
  google jsonb not null default '{}',
  assets jsonb not null default '{}',
  style jsonb not null default '{}',
  welcomed_at timestamptz,
  call_checked_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table client_onboarding enable row level security;
create policy "staff read onboarding guides" on client_onboarding for select using (private.staff_can_see_client(client_id));
