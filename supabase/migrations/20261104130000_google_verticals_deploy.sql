-- Google Verticals: a Google playbook per sub-vertical, built from our Google Hall of Fame and live non-brand winners
-- across the clients in it (the search intents that convert, the copy angles and headline types, the campaign
-- structures, landing page patterns, what fails). Never names a client.
create table if not exists public.google_playbooks (
  vertical_id uuid primary key references public.verticals(id) on delete cascade,
  summary text not null default '',
  intents jsonb not null default '[]'::jsonb,    -- [{ name, why, keywords: [{ text, match }], examples: [google_ideas.id] }]
  angles jsonb not null default '[]'::jsonb,     -- [{ name, type, headlines: [], descriptions: [], why, examples: [] }]
  structures jsonb not null default '[]'::jsonb, -- [{ name, how, why }]
  landing jsonb not null default '[]'::jsonb,    -- ["…"]
  watchouts jsonb not null default '[]'::jsonb,  -- ["…"]
  sources jsonb not null default '{}'::jsonb,    -- { clients, ads, keywords, terms }
  generated_at timestamptz,
  fingerprint text
);
alter table public.google_playbooks enable row level security;
create policy "staff read google playbooks" on public.google_playbooks for select to authenticated using (private.is_staff());

-- An idea from Ideas › Google (a winning ad, keyword or search term) taken to a client: copy around it, a campaign or
-- ad group around it, or keywords to add. Approved, edited or declined like a suggested brief; applied by hand from a
-- checklist, or pushed to Google Ads paused when Google writes are switched on.
create table if not exists public.google_deploys (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  idea_id uuid references public.google_ideas(id) on delete set null,
  idea jsonb not null default '{}'::jsonb, -- what the idea was, kept even if the winner drops out
  kind text not null check (kind in ('copy', 'campaign', 'keywords')),
  note text,
  status text not null default 'drafting' check (status in ('drafting', 'open', 'approved', 'declined', 'applied', 'partial', 'failed')),
  plan jsonb,
  error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decline_reason text,
  applied jsonb, -- { target: { campaignId, adGroupId }, results: [{ what, ok, error }] }
  applied_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists google_deploys_client on public.google_deploys (client_id, status);
alter table public.google_deploys enable row level security;
create policy "staff read google deploys" on public.google_deploys for select to authenticated using (private.staff_can_see_client(client_id));
