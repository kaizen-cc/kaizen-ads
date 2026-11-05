-- Creative uploaded on a ticket also goes into the client's Google Drive, in their "Ad Creative" folder:
-- Ad Creative / <Year> / <Month> / <Concept> / <Images | Videos | Carousels> / <Client> - <Concept> - V1 - 4x5.png
-- One Drive file per slot (a design's size, or a carousel's slide): a new round updates that same Drive file as a new
-- revision (Drive keeps the history); a deleted design or file moves to "_Replaced" next to it, never deleted.
-- Synced in the background (a queue with retries), never slowing the upload.

-- The client's "Ad Creative" folder: found by name inside their Drive folder, or set by hand on the client page
alter table public.clients add column if not exists ad_creative_folder_id text;
alter table public.clients add column if not exists ad_creative_folder_source text check (ad_creative_folder_source in ('found', 'set'));

-- Year, month, concept and format folders already found or made, so they're never made twice
create table public.client_drive_folders (
  client_id uuid not null references public.clients(id) on delete cascade,
  root_id text not null,
  path text not null,
  folder_id text not null,
  created_at timestamptz not null default now(),
  primary key (client_id, root_id, path)
);

-- One row per Drive file: the queue (what should be there) and the link (what is there)
create table public.creative_drive_files (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  request_id uuid,
  -- No foreign keys to designs or design_files: when they're deleted the row stays, to move the Drive file to _Replaced
  design_id uuid not null,
  slot text not null,
  op text not null default 'upload' check (op in ('upload', 'retire')),
  status text not null default 'pending' check (status in ('pending', 'syncing', 'synced', 'retired', 'error')),
  want_file_id uuid,
  synced_file_id uuid,
  synced_bytes bigint,
  synced_name text,
  drive_file_id text,
  drive_url text,
  drive_name text,
  error text,
  error_kind text check (error_kind in ('no_folder', 'no_access', 'too_large', 'other')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  synced_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (design_id, slot)
);
create index creative_drive_files_due on public.creative_drive_files (next_attempt_at) where status in ('pending', 'syncing', 'error');
create index creative_drive_files_client on public.creative_drive_files (client_id, status);
create index creative_drive_files_request on public.creative_drive_files (request_id);

-- Staff who can see the client see where its files are; only the server writes
alter table public.client_drive_folders enable row level security;
alter table public.creative_drive_files enable row level security;
create policy "staff read creative drive files" on public.creative_drive_files
  for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff read client drive folders" on public.client_drive_folders
  for select to authenticated using (private.staff_can_see_client(client_id));
revoke insert, update, delete on public.creative_drive_files from anon, authenticated;
revoke insert, update, delete on public.client_drive_folders from anon, authenticated;
revoke all on public.creative_drive_files from anon;
revoke all on public.client_drive_folders from anon;
