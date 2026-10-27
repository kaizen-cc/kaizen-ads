-- Every file and link shared about a client (in the client desk chat, or on the client page): kept as the client's
-- document history with what the AI read in it, and read by the AI whenever it works on the client. Never deleted.
create table if not exists public.client_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('file', 'link')),
  name text not null,
  path text, -- the file in the client-docs bucket
  url text, -- a link
  mime text,
  bytes bigint,
  title text, -- what it is, in a few words (the AI's read)
  summary text, -- what's in it that matters for the client
  text text, -- what could be read from it, for the AI later
  status text not null default 'reading' check (status in ('reading', 'ready', 'unreadable')),
  note text, -- why it couldn't be read
  via text not null default 'chat' check (via in ('chat', 'page')),
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists client_documents_client on public.client_documents (client_id, created_at desc);
alter table public.client_documents enable row level security;
create policy "staff read their clients' documents" on public.client_documents for select to authenticated using (private.staff_can_see_client(client_id));

-- Lessons the AI took from a shared document
alter table public.client_memory drop constraint if exists client_memory_source_check;
alter table public.client_memory add constraint client_memory_source_check check (source = any (array['team', 'client', 'review', 'copy', 'lab', 'audit', 'sprint', 'network', 'call', 'drive', 'doc']));

-- The files themselves: private, the first folder is the client (the same rule as creative)
insert into storage.buckets (id, name, public, file_size_limit) values ('client-docs', 'client-docs', false, 52428800) on conflict (id) do nothing;
create policy "staff upload client docs" on storage.objects for insert to authenticated
  with check (bucket_id = 'client-docs' and private.staff_can_see_client(private.path_client(name)));
create policy "staff read client docs" on storage.objects for select to authenticated
  using (bucket_id = 'client-docs' and private.staff_can_see_client(private.path_client(name)));
