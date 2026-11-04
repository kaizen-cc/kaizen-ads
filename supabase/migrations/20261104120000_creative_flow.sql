-- The creative ticket flow, fewer clicks: an exec or lead can disagree with an AI review note (kept as a learning the
-- creative review and the strategist read next time), and each AI review records whether it started on its own and
-- which designs it looked at (a revision review looks only at what changed).

alter table public.review_comments add column if not exists disagreed_at timestamptz;
alter table public.review_comments add column if not exists disagreed_by uuid references public.profiles(id) on delete set null;
alter table public.review_comments add column if not exists disagree_reason text;

create table if not exists public.creative_review_disagreements (
  id          uuid primary key default gen_random_uuid(),
  comment_id  uuid references public.review_comments(id) on delete set null,
  request_id  uuid references public.requests(id) on delete set null,
  client_id   uuid references public.clients(id) on delete cascade,
  area        text,
  severity    text,
  note        text not null,       -- what the AI said
  reason      text,                -- why the exec or lead disagreed (optional)
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists creative_review_disagreements_client on public.creative_review_disagreements (client_id, created_at desc);
alter table public.creative_review_disagreements enable row level security;
drop policy if exists "staff read disagreements" on public.creative_review_disagreements;
create policy "staff read disagreements" on public.creative_review_disagreements for select to authenticated
  using (client_id is null or exists (select 1 from public.clients c where c.id = client_id));

alter table public.creative_ai_reviews add column if not exists auto boolean not null default false;
alter table public.creative_ai_reviews add column if not exists scope text[]; -- the designs (D1, D2…) this run looked at; null = all

-- The copy check against what the client told us runs up front (when copy is written, opened and edited), kept with
-- the copy, so the status is the same everywhere and approving never springs a surprise. An exec or lead can approve
-- past it with a reason, kept as a learning so later checks weigh that rule.
alter table public.copy_sets add column if not exists violations jsonb;
alter table public.copy_sets add column if not exists checked_hash text;
alter table public.copy_sets add column if not exists checked_at timestamptz;
create table if not exists public.copy_rule_overrides (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  request_id uuid references public.requests(id) on delete set null,
  rule text not null, quote text, field text, reason text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists copy_rule_overrides_client on public.copy_rule_overrides (client_id, created_at desc);
alter table public.copy_rule_overrides enable row level security;
drop policy if exists "staff read overrides" on public.copy_rule_overrides;
create policy "staff read overrides" on public.copy_rule_overrides for select to authenticated using (exists (select 1 from public.clients c where c.id = client_id));
-- The copywriter (or a lead) can rebut one flag that reads the client's rule too strictly: kept as a learning like a
-- force approve, and dismissed for that copy (by its quote and rule) so it no longer blocks approving.
alter table public.copy_rule_overrides add column if not exists kind text not null default 'force' check (kind in ('force','rebut'));
alter table public.copy_rule_overrides add column if not exists set_id uuid references public.copy_sets(id) on delete set null;
alter table public.copy_sets add column if not exists dismissed jsonb not null default '[]'::jsonb;
