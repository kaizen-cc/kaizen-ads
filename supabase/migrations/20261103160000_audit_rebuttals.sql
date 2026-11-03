-- Pushing back on an audit: only people given the permission can disagree with a finding, and what they say teaches
-- every later audit of that client. Plus the full business audit (every channel at once) on the client page.

alter table profiles add column if not exists can_rebut_audits boolean not null default false;
update profiles set can_rebut_audits = true where email in ('kyle@kaizenmarketing.agency', 'dipesh@kaizenmarketing.agency');

create table if not exists business_audits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  status text not null default 'running' check (status in ('running','ready','failed')),
  step text,
  result jsonb,
  inputs jsonb,
  error text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists business_audits_client_idx on business_audits (client_id, created_at desc);
alter table business_audits enable row level security;

create table if not exists audit_rebuttals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  audit_kind text not null check (audit_kind in ('account','business')),
  audit_id uuid not null,
  item_key text not null,
  finding text not null,
  reason text not null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists audit_rebuttals_client_idx on audit_rebuttals (client_id, created_at desc);
create index if not exists audit_rebuttals_audit_idx on audit_rebuttals (audit_id);
alter table audit_rebuttals enable row level security;

-- The media buyer's rule for conversation starters, read by every media buyer agent (audits, fatigue, launcher, reports)
update ai_roles set core = core || E'\n\nConversation starters: a top-of-funnel Meta ad with frequency under 1.25, good spend, an average CPM and an above-average CTR but no conversions of its own is starting conversations and bringing people into the funnel. Never recommend pausing or turning it off, even when other ads in the ad set show better results. Judge it by its ad set''s and campaign''s overall success (traffic, cost per outreach, the ad set''s or campaign''s results against target): if they are succeeding, it keeps running.'
where key = 'media_buyer' and core not ilike '%conversation starters:%';

-- Whoever can see the client can read its business audits and the pushback on them
create policy "staff read business audits" on business_audits for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff read audit pushback" on audit_rebuttals for select to authenticated using (private.staff_can_see_client(client_id));
