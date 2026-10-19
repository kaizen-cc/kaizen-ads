-- Three audits at a time per person: a fourth waits as "queued", in the order it was asked for, until they start it.
alter table public.account_audits drop constraint account_audits_status_check;
alter table public.account_audits add constraint account_audits_status_check check (status in ('queued', 'running', 'ready', 'failed'));
alter table public.account_audits add column queued_at timestamptz;
