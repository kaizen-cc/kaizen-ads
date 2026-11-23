-- One item, one person (owner, Nov 23 2026). Every Overview item has a single owner: by default the person its source
-- names (who owes the reply, the account's buyer, the client's seat on that line); a transfer or a new due date is kept
-- here and wins. The ladder reads it too: a new owner or due date restarts the clock (the clock counts from the due
-- date). Every change is logged.

create table if not exists public.item_owners (
  key text primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  due_at timestamptz,
  -- What the item is, so it shows on the new owner's day even when their own sources don't produce it
  snapshot jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists item_owners_owner_idx on public.item_owners (owner_id);

create table if not exists public.item_owner_log (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  from_id uuid references public.profiles (id) on delete set null,
  to_id uuid references public.profiles (id) on delete set null,
  due_from timestamptz,
  due_to timestamptz,
  by_id uuid references public.profiles (id) on delete set null,
  note text,
  at timestamptz not null default now()
);
create index if not exists item_owner_log_key_idx on public.item_owner_log (key, at desc);

alter table public.item_owners enable row level security;
alter table public.item_owner_log enable row level security;

-- The team reads ownership (whose is it, since when); writes go through the server
drop policy if exists "staff read item owners" on public.item_owners;
create policy "staff read item owners" on public.item_owners for select to authenticated using ((select private.is_staff()));
drop policy if exists "staff read item owner log" on public.item_owner_log;
create policy "staff read item owner log" on public.item_owner_log for select to authenticated using ((select private.is_staff()));
