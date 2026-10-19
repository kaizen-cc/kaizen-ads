-- The audit's milestones as it really does them: each step's status, what it found, and when it started and finished.
alter table public.account_audits add column steps jsonb not null default '[]';
