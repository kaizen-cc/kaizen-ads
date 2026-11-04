-- A business audit's moves go to the teams: each paid channel's sprint (added to one being worked, never reset) and
-- the rest as the client's tasks. The audit keeps where each move went; a move it added says so on the sprint.
alter table public.business_audits add column if not exists routing jsonb;

alter table public.optimization_sprints add column if not exists business_audit_id uuid references public.business_audits(id) on delete set null;

alter table public.sprint_actions add column if not exists business_audit_id uuid references public.business_audits(id) on delete set null;
alter table public.sprint_actions drop constraint if exists sprint_actions_source_check;
alter table public.sprint_actions add constraint sprint_actions_source_check check (source in ('audit', 'buyer', 'business_audit'));
