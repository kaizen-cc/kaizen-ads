-- Kaizen's document system in Google (Nov 24 2026): every client-facing document the assistant or Kaizen AI makes is a
-- Google Doc or Google Slides file in the house style (templates: proposal deck, project quote, Scope of Work, plus an
-- open doc and deck), filed in the client's Headquarters › Proposals & SOWs, a prospect's Kaizen Sales › Prospects
-- folder, or the person's own Drive. And Kaizen's rate card: the starting prices documents quote, per service line and
-- tier, one-time or monthly; the executives keep it in Settings. It starts empty: until it's filled, documents mark
-- prices "[Price to confirm]" and the assistant asks for them.

alter table public.kaizen_documents add column if not exists template text;
alter table public.kaizen_documents add column if not exists google_id text;
alter table public.kaizen_documents add column if not exists google_url text;
alter table public.kaizen_documents add column if not exists google_kind text check (google_kind in ('doc', 'slides'));
alter table public.kaizen_documents add column if not exists folder_id text;
alter table public.kaizen_documents add column if not exists folder_place text;
alter table public.kaizen_documents add column if not exists prospect_name text;
alter table public.kaizen_documents drop constraint if exists kaizen_documents_kind_check;
alter table public.kaizen_documents add constraint kaizen_documents_kind_check check (kind in ('sow', 'proposal', 'handoff', 'one_pager', 'case_study', 'quote', 'doc', 'deck'));
create index if not exists kaizen_documents_prospects on public.kaizen_documents (prospect_name) where prospect_name is not null and client_id is null;

create table if not exists public.rate_card (
  id          uuid primary key default gen_random_uuid(),
  service     text not null,
  tier        text,
  label       text not null,
  cadence     text not null check (cadence in ('one_time', 'month')),
  amount      numeric(12, 2) not null check (amount > 0),
  note        text,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  updated_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists rate_card_service on public.rate_card (service, sort_order) where active;
alter table public.rate_card enable row level security;
drop policy if exists "staff read the rate card" on public.rate_card;
create policy "staff read the rate card" on public.rate_card for select to authenticated using ((select private.is_staff()));
drop policy if exists "execs keep the rate card" on public.rate_card;
create policy "execs keep the rate card" on public.rate_card for all to authenticated using ((select private.is_exec())) with check ((select private.is_exec()));
