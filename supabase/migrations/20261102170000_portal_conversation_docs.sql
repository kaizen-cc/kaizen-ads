-- Files a client shares in their portal conversation (their own uploads), and customer lists kept out of every AI read
alter table client_documents drop constraint if exists client_documents_via_check;
alter table client_documents add constraint client_documents_via_check check (via = any (array['chat', 'page', 'portal']));
alter table client_documents add column if not exists uploaded_by_contact uuid references contacts(id) on delete set null;
alter table client_documents add column if not exists sensitive boolean not null default false;
