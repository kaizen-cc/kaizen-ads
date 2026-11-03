-- The Brand Bible's open questions, each labeled and routed (the client first where it's theirs to answer, then the
-- right arm of the team, and the execs on escalation), answered in place with a conversation of its own.
create table if not exists public.bible_questions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  qid text not null,
  question text not null,
  category text not null check (category in ('offer', 'creative', 'media', 'business')),
  options text[] not null default '{}',
  multi boolean not null default false,
  stage text not null check (stage in ('client', 'media_buyer', 'head_of_creative', 'exec', 'answered')),
  answer text,
  answered_by text,
  answered_via text check (answered_via in ('client', 'team', 'chat')),
  answered_at timestamptz,
  thread jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, qid)
);
create index if not exists bible_questions_open on public.bible_questions (client_id) where stage <> 'answered';
alter table public.bible_questions enable row level security;
drop policy if exists bible_questions_read on public.bible_questions;
create policy bible_questions_read on public.bible_questions for select to authenticated
  using (private.staff_can_see_client(client_id));

-- The pages the Bible sends people to (and landing pages from creative requests): checked every few months and
-- refreshed right before a brief, so a dead link or a changed page (a new offer) is caught.
create table if not exists public.bible_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  url text not null,
  label text,
  source text not null default 'bible' check (source in ('bible', 'request', 'site')),
  status int,
  ok boolean,
  title text,
  digest text,
  summary text,
  checked_at timestamptz,
  changed_at timestamptz,
  change_note text,
  created_at timestamptz not null default now(),
  unique (client_id, url)
);
alter table public.bible_links enable row level security;
drop policy if exists bible_links_read on public.bible_links;
create policy bible_links_read on public.bible_links for select to authenticated
  using (private.staff_can_see_client(client_id));

-- Website issues the Bible found: the exact page, and whether it's for the client (a suggestion, when their website
-- isn't ours) or for the team (something we should fix or watch). Both are context for audits and creative.
create table if not exists public.website_issues (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  key text not null,
  issue text not null,
  page_url text,
  audience text not null check (audience in ('client', 'team')),
  status text not null default 'open' check (status in ('open', 'sent', 'fixed', 'dismissed')),
  found_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_by uuid references public.profiles (id),
  unique (client_id, key)
);
alter table public.website_issues enable row level security;
drop policy if exists website_issues_read on public.website_issues;
create policy website_issues_read on public.website_issues for select to authenticated
  using (private.staff_can_see_client(client_id));

-- The client's whole story, packaged at offboarding (and on demand): the Bible, its change log and the account
-- context, so a client who comes back picks up where we left off.
create table if not exists public.client_exports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  reason text not null default 'on demand' check (reason in ('offboarding', 'on demand')),
  markdown text not null,
  made_by uuid references public.profiles (id),
  restored_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.client_exports enable row level security;
drop policy if exists client_exports_read on public.client_exports;
create policy client_exports_read on public.client_exports for select to authenticated
  using (private.staff_can_see_client(client_id));

-- When the Bible's notes were last read into website issues (again after each rebuild)
alter table public.client_brand_bibles add column if not exists issues_read_at timestamptz;
