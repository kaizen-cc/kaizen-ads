-- A campaign's result chosen by hand on a KPI card (campaign id -> action type), over what it's optimized for
alter table public.kpi_targets add column if not exists campaign_results jsonb not null default '{}'::jsonb;
