-- A client's whole email history with Kaizen (sales emails before the close included), pulled once per address or
-- domain: what's been pulled is listed here, so a contact added later is pulled on its own
alter table clients add column if not exists email_history_covered text[] not null default '{}';
alter table clients add column if not exists email_history_at timestamptz;
