-- Saved for later: a reference (a live market ad, a winning ad from a similar client, a pattern, a brief) starred for
-- one client, so whoever makes that client's next creative (buyer, strategist, designer, editor) finds it in the new
-- request flow and on the ticket. Making a brief from one marks it used; the row stays (never deleted for being used).
create table if not exists public.client_saved_references (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete cascade,
  source           text not null check (source in ('market', 'winner', 'pattern', 'brief')),
  -- The thing's own id where it came from: a market_ads id, a Meta ad id, a client_patterns id, a creative_suggestions id
  ref_id           text not null,
  url              text,
  thumbnail        text,
  title            text,
  -- Who or what it's from (the brand, the similar client's niche) and its format
  subtitle         text,
  format           text check (format in ('image', 'video', 'carousel')),
  -- What's needed to brief from it again (a winner's numbers, a market ad's angle)
  data             jsonb not null default '{}'::jsonb,
  saved_by         uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  used_at          timestamptz,
  used_request_id  uuid references public.requests(id) on delete set null,
  unique (client_id, source, ref_id)
);
create index if not exists client_saved_references_open on public.client_saved_references (client_id, created_at desc) where used_at is null;

alter table public.client_saved_references enable row level security;
drop policy if exists "saved references: staff read" on public.client_saved_references;
create policy "saved references: staff read" on public.client_saved_references for select to authenticated using (private.staff_can_see_client(client_id));
drop policy if exists "saved references: staff add" on public.client_saved_references;
create policy "saved references: staff add" on public.client_saved_references for insert to authenticated with check (private.staff_can_see_client(client_id));
drop policy if exists "saved references: staff update" on public.client_saved_references;
create policy "saved references: staff update" on public.client_saved_references for update to authenticated using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));
drop policy if exists "saved references: staff remove" on public.client_saved_references;
create policy "saved references: staff remove" on public.client_saved_references for delete to authenticated using (private.staff_can_see_client(client_id) and used_at is null);
