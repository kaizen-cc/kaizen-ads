-- Better briefs (the creative team, Nov 20 2026).
-- 1. Per client, the assets that were waived or that the client confirmed aren't available: the asset check never asks
--    for them again, and the brief writer is told not to.
-- 2. The creative leads rate each auto-drafted brief, good or needs work, with one line why: a brief_corrections row
--    (kind 'rating') that becomes a lesson for the brief writer like every correction.
create table if not exists public.client_asset_waivers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  label text not null,
  norm text not null,
  how text not null default 'waived' check (how in ('waived', 'unavailable')),
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (client_id, norm)
);
alter table public.client_asset_waivers enable row level security;
drop policy if exists "staff read asset waivers" on public.client_asset_waivers;
create policy "staff read asset waivers" on public.client_asset_waivers for select to authenticated
  using ((select private.is_staff()) and ((select private.staff_sees_all()) or client_id = any ((select private.staff_client_ids())::uuid[])));

alter table public.brief_corrections drop constraint if exists brief_corrections_kind_check;
alter table public.brief_corrections add constraint brief_corrections_kind_check check (kind in ('correction', 'review', 'override', 'answer', 'ask_client', 'rating'));
alter table public.brief_corrections add column if not exists rating text check (rating in ('good', 'needs_work'));
