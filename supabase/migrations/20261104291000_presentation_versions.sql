-- Every client presentation that's been written, kept: a new draft written after the Bible is rebuilt never replaces
-- one that's already with the client (sent or approved) — it's drafted here as a new version, and a draft that's
-- replaced by a newer one is kept here as history
create table if not exists public.client_presentation_versions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  -- writing | draft | failed (a new version beside the one with the client) · superseded (an older draft, kept)
  status text not null default 'writing',
  deck jsonb,
  without_intake boolean not null default false,
  bible_version text,
  error text,
  started_at timestamptz not null default now(),
  drafted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists client_presentation_versions_client on public.client_presentation_versions (client_id, created_at desc);

alter table public.client_presentation_versions enable row level security;

drop policy if exists "staff read presentation versions" on public.client_presentation_versions;
create policy "staff read presentation versions" on public.client_presentation_versions
  for select using (private.staff_can_see_client(client_id));

-- Which Bible version the current presentation was written from, so a rebuilt Bible's presentation is written again
alter table public.client_presentations add column if not exists bible_version text;
