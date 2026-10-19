-- A lesson that worked for one client, shared with truly similar clients (same sub-vertical, then a strict AI check
-- of product, buyer, sales motion and price point). Never names the client it came from; removable like any memory.
alter table public.client_memory drop constraint client_memory_source_check;
alter table public.client_memory add constraint client_memory_source_check check (source = any (array['team', 'client', 'review', 'copy', 'lab', 'audit', 'sprint', 'network']));
alter table public.client_memory
  add column origin_client_id uuid references public.clients (id) on delete set null,
  add column origin_memory_id uuid references public.client_memory (id) on delete set null,
  add column share_reason text;
create index client_memory_origin on public.client_memory (origin_memory_id) where origin_memory_id is not null;
