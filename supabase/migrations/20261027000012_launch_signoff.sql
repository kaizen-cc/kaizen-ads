-- Launch sign-off: a human confirms what Meta locks once an ad set is published (the campaign's objective, the ad
-- set's pixel, conversion event and attribution) before the launcher creates anything. Kept on the launch, and per ad
-- set and exact settings, so later launches into an ad set already signed off with the same settings go on their own.

alter table public.launches add column if not exists signoff jsonb;

create table if not exists public.launch_signoffs (
  adset_id text not null,
  fingerprint text not null,
  profile_id uuid references public.profiles(id) on delete set null,
  signed_at timestamptz not null default now(),
  primary key (adset_id, fingerprint)
);

alter table public.launch_signoffs enable row level security;

drop policy if exists "staff read launch signoffs" on public.launch_signoffs;
create policy "staff read launch signoffs" on public.launch_signoffs for select to authenticated using (private.current_profile_id() is not null);
