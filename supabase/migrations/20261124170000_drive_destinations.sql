-- Where each person saves in Google Drive (the owner's rule, Nov 24 2026): a folder they confirmed is remembered per
-- person, client and kind of document, so the next save is one quick "Saving to <path>, OK?" instead of a guess.
-- Written by the server after a save (src/lib/drive-destination.ts); each person reads their own.
create table if not exists public.drive_destinations (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  client_id    uuid references public.clients (id) on delete cascade,
  -- The client's id, or "p:<name>" for a prospect who isn't a client yet, or "" (src/lib/drive-destination-core.ts)
  client_key   text not null default '',
  prospect     text,
  doc_type     text not null,
  folder_id    text not null,
  path         text[] not null default '{}',
  link         text,
  confirmed_at timestamptz not null default now(),
  constraint drive_destinations_key unique (profile_id, client_key, doc_type)
);
alter table public.drive_destinations enable row level security;
create policy "own drive destinations" on public.drive_destinations for select to authenticated using (profile_id = (select private.current_profile_id()));

-- The folder a background job resolved, its whole path, for the notices
alter table public.after_call_jobs add column if not exists drive_folder_path text;
