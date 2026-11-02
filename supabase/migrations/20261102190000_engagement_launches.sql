-- A new client's first ads, live within 48 hours: their best recent Facebook and Instagram posts, picked against the
-- Brand Bible, confirmed by the client, built as a paused engagement campaign with the launch checklist checked, then
-- turned on by the buyer (and the client told).
create table if not exists engagement_launches (
  client_id uuid primary key references clients(id) on delete cascade,
  status text not null default 'finding' check (status in ('finding', 'proposed', 'confirmed', 'building', 'built', 'live', 'none', 'failed')),
  account text,
  page_id text,
  ig_id text,
  posts jsonb not null default '[]',
  chosen text[] not null default '{}',
  plan jsonb,
  checklist jsonb not null default '[]',
  campaign_id text,
  adset_id text,
  ad_ids text[] not null default '{}',
  note text,
  error text,
  confirmed_at timestamptz,
  confirmed_by text,
  built_at timestamptz,
  live_at timestamptz,
  live_by uuid references profiles(id),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table engagement_launches enable row level security;
create policy "staff read engagement launches" on engagement_launches for select using (private.staff_can_see_client(client_id));
