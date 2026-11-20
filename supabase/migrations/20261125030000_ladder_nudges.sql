-- The escalation ladder (Nov 20 2026): every line's alerts go to the item's owner first; after 48 hours with nothing
-- done, the owner's lead or head gets a card with a Slack message drafted to nudge the teammate, sent as the lead from
-- their own Slack. One nudge per item (key). Written by the server; the lead reads and acts on their own.
create table if not exists public.ladder_nudges (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  item_key text not null,
  kind text not null default 'other',
  line text,
  client_id uuid references public.clients(id) on delete cascade,
  client_name text,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  lead_id uuid not null references public.profiles(id) on delete cascade,
  what text not null,
  href text,
  since timestamptz not null,
  draft text not null,
  status text not null default 'open' check (status in ('open', 'sent', 'dismissed', 'resolved')),
  sent_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ladder_nudges_lead_idx on public.ladder_nudges (lead_id, status);
create index if not exists ladder_nudges_item_idx on public.ladder_nudges (item_key) where status = 'open';
alter table public.ladder_nudges enable row level security;
drop policy if exists "lead reads own nudges" on public.ladder_nudges;
create policy "lead reads own nudges" on public.ladder_nudges for select to authenticated
  using (lead_id = (select private.current_profile_id()) or (select private.is_exec()));
