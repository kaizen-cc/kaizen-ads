-- Disk IO relief on the small database.
-- The audit feed polls by creator; without these it seq-scanned account_audits every few seconds.
create index if not exists account_audits_creator on public.account_audits (created_by, created_at);
create index if not exists account_audits_creator_all on public.account_audits (created_by, created_at);
-- The playbook rebuild reads each client's newest row (updated_at) to decide who is next.
create index if not exists client_ledger_client_updated on public.client_ledger (client_id, updated_at desc);
