-- Extra metric boxes on one KPI card (ROAS next to cost per lead, engagement, CTR…), chosen per KPI so they don't change anyone else's view.
-- Keys from the explorer's list, or action:<meta action type> / cost:<meta action type> for anything the account reports.
alter table public.kpi_targets add column extra_metrics text[] not null default '{}';
