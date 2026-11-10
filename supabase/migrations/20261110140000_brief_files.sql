-- Briefs carry real creative thinking (the lead video editor's feedback, Nov 10 2026):
-- 1. Each Drive file's folder id, so an asset a brief lists by folder links to that folder (files already link to
--    themselves through client_assets.url). Filled by the next Drive sync.
-- 2. Files added to "Talk it through" and the brief's revise chat (images, videos, audio, PDFs): private, under the
--    client's id; the server signs uploads and reads (staff who can see the client), served at /api/brief-files/...
alter table public.client_assets add column if not exists folder_id text;

insert into storage.buckets (id, name, public, file_size_limit)
values ('brief-files', 'brief-files', false, 314572800)
on conflict (id) do nothing;
