-- Campaigns the client runs themselves, left out of a KPI's numbers (spend, results, cost, pacing): we're not on the hook for them
alter table public.kpi_targets add column if not exists excluded_campaigns text[] not null default '{}';
