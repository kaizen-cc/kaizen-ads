-- Things a person cleared off their own Overview (done or dismissed, for them only; nobody else's board changes)
create table if not exists public.hidden_items (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  key text not null,
  how text not null default 'dismissed' check (how in ('done', 'dismissed')),
  hidden_at timestamptz not null default now(),
  primary key (profile_id, key)
);
alter table public.hidden_items enable row level security;
create policy "own hidden items" on public.hidden_items for all
  using (profile_id = private.current_profile_id())
  with check (profile_id = private.current_profile_id());
