-- Regenerate: a report rewritten from scratch with fresh platform data. The draft it replaced is kept in `previous`
-- (its message, sections, numbers and checks) so "Undo regenerate" can bring it back within a day; `regenerated_at`
-- marks when it was asked for, so the queue pulls the account's latest numbers before writing it.
alter table public.reports add column if not exists previous jsonb;
alter table public.reports add column if not exists regenerated_at timestamptz;
