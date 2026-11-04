-- Indexes for the client page and the Board's hot reads that had none (checked against pg_indexes first)
-- A client's call promises, by the calls about them
create index if not exists call_commitments_client_call on public.call_commitments (client_id, call_id);
-- Tickets migrated from Asana (the Board looks them up by request)
create index if not exists asana_tasks_request on public.asana_tasks (request_id) where request_id is not null;
-- The approved part of a partly approved ticket (the Board finds it by its parent)
create index if not exists requests_parent on public.requests (parent_id) where parent_id is not null;
-- The client page counts what's on their Drive by kind
create index if not exists client_assets_client_kind on public.client_assets (client_id, kind);
