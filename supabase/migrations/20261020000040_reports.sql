-- Client reports: the weekly recap (Mondays: last 7 days and month to date) and the monthly recap (by the 5th), drafted
-- for each buyer from the account's data and the work done, in their voice, checked by the AI, posted to Slack as them.
create table public.report_bundles (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('monthly')),
  period_start date not null,
  period_end date not null,
  token text not null unique default encode(gen_random_bytes(18), 'hex'),
  status text not null default 'collecting' check (status in ('collecting', 'sending', 'sent', 'failed')),
  sent_at timestamptz,
  delivered jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  unique (client_id, kind, period_start)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  target_id uuid not null references public.kpi_targets(id) on delete cascade,
  bundle_id uuid references public.report_bundles(id) on delete cascade,
  platform text not null,
  kind text not null check (kind in ('weekly', 'monthly')),
  period_start date not null,
  period_end date not null,
  owner_id uuid references public.profiles(id),
  status text not null default 'drafting' check (status in ('drafting', 'draft', 'submitted', 'posted', 'skipped', 'failed')),
  metrics jsonb,
  work jsonb,
  message text,
  sections jsonb,
  extras text,
  qa jsonb,
  chat jsonb not null default '[]'::jsonb,
  slack_channel text,
  slack_ts text,
  posted_at timestamptz,
  posted_by uuid references public.profiles(id),
  submitted_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (target_id, kind, period_start)
);
create index reports_owner on public.reports (owner_id, period_start desc);
create index reports_client on public.reports (client_id, period_start desc);

-- What each client likes in a report, learned from the buyers' edits and chats ("add lead quality", "keep it short")
create table public.client_report_prefs (
  client_id uuid primary key references public.clients(id) on delete cascade,
  notes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- A person's own Slack sign-in, so reports post as them. Server-only: no one reads tokens through the API.
create table public.slack_user_tokens (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  slack_user_id text not null,
  team_id text,
  token text not null,
  scopes text,
  created_at timestamptz not null default now()
);

alter table public.report_bundles enable row level security;
alter table public.reports enable row level security;
alter table public.client_report_prefs enable row level security;
alter table public.slack_user_tokens enable row level security;
create policy "staff read report bundles" on public.report_bundles for select to authenticated using (private.is_staff());
create policy "staff read reports" on public.reports for select to authenticated using (private.is_staff());
create policy "staff read report prefs" on public.client_report_prefs for select to authenticated using (private.is_staff());
